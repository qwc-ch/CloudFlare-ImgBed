import { fetchOthersConfig } from "../utils/sysConfig";
import { readIndex } from "../utils/indexManager";
import { detectDevice, resolveOrientation, addClientHintsHeaders } from "./adaptive.js";

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

let othersConfig = {};
let allowRandom = false;

// 文件列表缓存版本号：变更后旧的（可能已被空列表毒化的）边缘节点缓存自动失效
const FILE_LIST_CACHE_VERSION = 'v2';

export async function onRequest(context) {
    // Contents of context object
    const {
      request, // same as existing Worker API
      env, // same as existing Worker API
      params, // if filename includes [id] or [[path]]
      waitUntil, // same as ctx.waitUntil in existing Worker API
      next, // used for middleware or to fetch assets
      data, // arbitrary space for passing data between middlewares
    } = context;
    const requestUrl = new URL(request.url);

    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    // 读取其他设置
    othersConfig = await fetchOthersConfig(env);
    allowRandom = othersConfig.randomImageAPI.enabled;
    const allowedDir = othersConfig.randomImageAPI.allowedDir;

    // 检查是否启用了随机图功能
    if (allowRandom != true) {
        return new Response(JSON.stringify({ error: "Random is disabled" }), { status: 403, headers: corsHeaders });
    }

    // 处理允许的目录，每个目录调整为标准格式，去掉首尾空格，去掉开头的/，替换多个连续的/为单个/，去掉末尾的/
    const allowedDirList = allowedDir.split(',');
    const allowedDirListFormatted = allowedDirList.map(item => {
        return item.trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
    });

    // 从params中读取返回的文件类型
    let fileType = requestUrl.searchParams.get('content');
    if (fileType == null) {
        fileType = ['image'];
    } else {
        fileType = fileType.split(',');
    }

    // 读取图片方向参数：landscape(横图), portrait(竖图), square(方图), auto(自适应)
    const orientationParam = requestUrl.searchParams.get('orientation') || '';

    // 根据参数值决定行为
    const VALID_ORIENTATIONS = ['landscape', 'portrait', 'square'];
    let orientation = '';
    let isAutoMode = false;

    if (VALID_ORIENTATIONS.includes(orientationParam)) {
        // 手动指定有效方向，直接使用
        orientation = orientationParam;
    } else if (orientationParam === 'auto') {
        // 自适应模式：检测设备并自动决策
        isAutoMode = true;
        const deviceInfo = detectDevice(request);
        orientation = resolveOrientation(deviceInfo);
    }
    // 其他情况（未指定或无效值）：orientation 保持空字符串，不过滤

    // 读取指定文件夹
    const paramDir = requestUrl.searchParams.get('dir') || '';
    const dir = paramDir.replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');

    // 检查是否在允许的目录中，或是允许目录的子目录
    let dirAllowed = false;
    for (let i = 0; i < allowedDirListFormatted.length; i++) {
        if (allowedDirListFormatted[i] === '' || dir === allowedDirListFormatted[i] || dir.startsWith(allowedDirListFormatted[i] + '/')) {
            dirAllowed = true;
            break;
        }
    }
    if (!dirAllowed) {
        return new Response(JSON.stringify({ error: "Directory not allowed" }), { status: 403, headers: corsHeaders });
    }

    // 调用randomFileList接口，读取KV数据库中的所有记录
    let allRecords = await getRandomFileList(context, requestUrl, dir);

    // 索引读取失败：返回503让客户端重试，不能当作“空目录”返回200
    if (allRecords === null) {
        return new Response(JSON.stringify({ error: "Failed to read file index" }), { status: 503, headers: corsHeaders });
    }

    // 筛选出符合fileType要求的记录
    allRecords = allRecords.filter(item => { return fileType.some(type => item.FileType?.includes(type)) });

    // 保存过滤前的记录，用于自适应模式降级
    const allRecordsBeforeOrientationFilter = allRecords;

    // 根据图片方向筛选
    if (orientation && allRecords.length > 0) {
        const SQUARE_THRESHOLD = 0.1; // 宽高比差异小于10%视为方图
        allRecords = allRecords.filter(item => {
            // 如果没有尺寸信息，跳过该记录
            if (!item.Width || !item.Height) return false;

            const ratio = item.Width / item.Height;
            switch (orientation) {
                case 'landscape': // 横图：宽 > 高
                    return ratio > (1 + SQUARE_THRESHOLD);
                case 'portrait': // 竖图：高 > 宽
                    return ratio < (1 - SQUARE_THRESHOLD);
                case 'square': // 方图：宽 ≈ 高
                    return ratio >= (1 - SQUARE_THRESHOLD) && ratio <= (1 + SQUARE_THRESHOLD);
                default:
                    return true;
            }
        });
    }

    // 自适应模式降级：过滤后无匹配图片时，降级到全部图片
    if (isAutoMode && orientation && allRecords.length === 0) {
        allRecords = allRecordsBeforeOrientationFilter;
    }

    // 构建响应头：添加 CORS 跨域响应头，自适应模式下添加 Client Hints 协商头
    const responseHeaders = new Headers(corsHeaders);
    if (isAutoMode) {
        addClientHintsHeaders(responseHeaders);
    }

    if (allRecords.length == 0) {
        // 空结果返回503而非200 {}：200会让<img>当成损坏图片，且可能被中间层缓存
        return new Response(JSON.stringify({ error: "No image found" }), { status: 503, headers: responseHeaders });
    } else {
        const randomIndex = Math.floor(Math.random() * allRecords.length);
        const randomKey = allRecords[randomIndex];
        const randomPath = '/file/' + randomKey.name;
        let randomUrl = randomPath;

        const randomType = requestUrl.searchParams.get('type');
        const resType = requestUrl.searchParams.get('form');
        
        // if param 'type' is set to 'url', return the full URL
        if (randomType == 'url') {
            randomUrl = requestUrl.origin + randomPath;
        }

        // if param 'type' is set to 'img', return the image
        if (randomType == 'img') {
            // Return an image response
            randomUrl = requestUrl.origin + randomPath;
            let contentType = 'image/jpeg';
            const imgHeaders = new Headers(responseHeaders);
            return new Response(await fetch(randomUrl).then(res => {
                contentType = res.headers.get('content-type');
                return res.blob();
            }), {
                headers: (() => {
                    imgHeaders.set('Content-Type', contentType || 'image/jpeg');
                    return imgHeaders;
                })(),
                status: 200
            });
        }
        
        if (resType == 'text') {
            return new Response(randomUrl, { status: 200, headers: responseHeaders });
        } else {
            return new Response(JSON.stringify({ url: randomUrl }), { status: 200, headers: responseHeaders });
        }
    }
}

async function getRandomFileList(context, url, dir) {
    // 检查缓存中是否有记录，有则直接返回
    const cache = caches.default;
    const cacheKey = `${url.origin}/api/randomFileList?dir=${dir}&v=${FILE_LIST_CACHE_VERSION}`;
    const cacheRes = await cache.match(cacheKey);
    if (cacheRes) {
        return JSON.parse(await cacheRes.text());
    }

    const indexResult = await readIndex(context, { directory: dir, count: -1, includeSubdirFiles: true, accessStatus: 'normal' });

    // 索引读取失败时返回null，由调用方返回503；绝不能把失败当成“空目录”缓存
    if (!indexResult || indexResult.success !== true) {
        return null;
    }

    // 仅保留记录的name和metadata中的必要字段
    const allRecords = (indexResult.files || []).map(item => {
        return {
            name: item.id,
            FileType: item.metadata?.FileType,
            Width: item.metadata?.Width,
            Height: item.metadata?.Height
        }
    });

    // 只缓存非空结果，避免空列表在边缘节点上被缓存24小时
    if (allRecords.length > 0) {
        await cache.put(cacheKey, new Response(JSON.stringify(allRecords), {
            headers: {
                "Content-Type": "application/json",
            }
        }), {
            expirationTtl: 24 * 60 * 60
        });
    }

    return allRecords;
}