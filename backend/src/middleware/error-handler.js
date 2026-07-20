/**
 * 错误处理中间件
 * 统一处理所有错误响应
 */

const isProduction = process.env.NODE_ENV === 'production';

/**
 * 通用错误消息映射（生产环境使用）
 */
const GENERIC_ERROR_MESSAGES = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout'
};

/**
 * 创建错误响应
 */
export function createErrorResponse(error, req) {
    const statusCode = error.statusCode || error.status || 500;

    // 生产环境使用通用错误消息，避免泄露内部信息
    let message;
    if (isProduction && statusCode >= 500) {
        message = GENERIC_ERROR_MESSAGES[statusCode] || 'Internal Server Error';
    } else {
        message = error.message || GENERIC_ERROR_MESSAGES[statusCode] || 'Internal Server Error';
    }

    return {
        statusCode,
        body: {
            error: {
                message,
                type: error.type || 'server_error',
                code: error.code || 'internal_error'
            }
        }
    };
}

/**
 * 错误处理中间件
 */
export function handleError(error, req, res) {
    const errorResponse = createErrorResponse(error, req);

    // 记录错误日志（生产环境隐藏堆栈）
    const logData = {
        method: req.method,
        url: req.url,
        statusCode: errorResponse.statusCode,
        message: error.message
    };

    // 仅在非生产环境或明确开启调试时记录堆栈
    if (!isProduction || process.env.DEBUG_STACK === 'true') {
        logData.stack = error.stack;
    }

    console.error('[Error]', logData);

    // 发送错误响应
    res.writeHead(errorResponse.statusCode, {
        'Content-Type': 'application/json'
    });
    res.end(JSON.stringify(errorResponse.body));
}
