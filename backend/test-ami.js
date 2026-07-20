/**
 * AMI API 测试脚本 - 完整流程
 * 1. 创建 project
 * 2. 发送消息
 */

import axios from 'axios';
import * as zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const AMI_BASE_URL = 'https://app.ami.dev';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Ami/0.0.8 Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36';

function generateMessageId() {
    return Math.random().toString(36).substring(2, 23);
}

// posthog cookie (从抓包中获取)
const POSTHOG_COOKIE = 'ph_phc_ga1WRsEZjpgxKjW0wXBX18wwhk6GSTUqGRSH6UKFR1Z_posthog=%7B%22%24device_id%22%3A%22019c1e29-3e43-7b7b-8cff-2c27333c0dcb%22%2C%22distinct_id%22%3A%22rfFxc6_traArPfQVR9yq7%22%2C%22%24sesid%22%3A%5B1770039208184%2C%22019c1e87-43ac-7dda-a865-12661c4434a2%22%2C1770038707107%5D%2C%22%24epp%22%3Atrue%2C%22%24initial_person_info%22%3A%7B%22r%22%3A%22%24direct%22%2C%22u%22%3A%22https%3A%2F%2Fapp.ami.dev%2F%22%7D%7D';

// 通用请求头
function getCommonHeaders(wosSession) {
    return {
        'host': 'app.ami.dev',
        'sec-ch-ua-platform': '"macOS"',
        'sec-ch-ua': '"Not_A Brand";v="99", "Chromium";v="142"',
        'sec-ch-ua-mobile': '?0',
        'user-agent': USER_AGENT,
        'content-type': 'application/json',
        'accept': '*/*',
        'origin': AMI_BASE_URL,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': `${AMI_BASE_URL}/dashboard`,
        'accept-encoding': 'gzip, deflate, br, zstd',
        'accept-language': 'zh-CN',
        'cookie': `wos-session=${wosSession}; ${POSTHOG_COOKIE}`,
        'priority': 'u=1, i',
    };
}

// 步骤1: 创建 project
async function createProject(wosSession, cwd, title) {
    console.log('=== 步骤1: 创建 Project ===');

    const url = `${AMI_BASE_URL}/api/v1/trpc/projects.create`;
    const body = { cwd, title };

    console.log('请求 URL:', url);
    console.log('请求体:', JSON.stringify(body));

    const headers = getCommonHeaders(wosSession);
    headers['content-length'] = JSON.stringify(body).length;

    try {
        const response = await axios({
            method: 'POST',
            url,
            headers,
            data: body,
            timeout: 30000,
        });

        console.log('响应状态:', response.status);
        console.log('响应数据:', JSON.stringify(response.data, null, 2));

        const { projectId, chatId } = response.data.result.data;
        console.log(`\n创建成功! projectId: ${projectId}, chatId: ${chatId}\n`);
        return { projectId, chatId };

    } catch (error) {
        console.error('创建 Project 失败:', error.message);
        if (error.response) {
            console.error('响应状态:', error.response.status);
            console.error('响应数据:', JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

// 生成 trace ID
function generateTraceId() {
    return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function generateSpanId() {
    return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// 步骤2: 发送消息
async function sendMessage(wosSession, projectId, chatId, userMessage, cwd) {
    console.log('=== 步骤2: 发送消息 ===');

    const url = `${AMI_BASE_URL}/api/v1/agent/v2`;

    // 请求体 - 尝试添加 projectId 和 chatId
    const requestBody = {
        projectId: projectId,
        chatId: chatId,
        messages: [
            {
                id: generateMessageId(),
                role: 'user',
                parts: [{ type: 'text', text: userMessage }]
            },
            {
                id: generateMessageId(),
                role: 'assistant',
                parts: [],
                metadata: {
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    model: 'optimistic'
                }
            }
        ],
        agentUrl: AMI_BASE_URL,
        context: {
            environment: {
                cwd: cwd,
                homeDir: process.env.HOME,
                workingDirectory: cwd,
                isGitRepo: false,
                allFiles: []
            }
        }
    };

    console.log('请求 URL:', url);
    console.log('请求体:', JSON.stringify(requestBody, null, 2).substring(0, 500));

    // Gzip 压缩
    const jsonBody = JSON.stringify(requestBody);
    const compressedBody = await gzip(Buffer.from(jsonBody, 'utf-8'));

    // 生成 sentry trace
    const traceId = generateTraceId();
    const spanId = generateSpanId();

    const headers = getCommonHeaders(wosSession);
    headers['content-encoding'] = 'gzip';
    headers['content-length'] = compressedBody.length;
    headers['referer'] = `${AMI_BASE_URL}/chat/${projectId}?chat=${chatId}`;
    headers['baggage'] = `sentry-environment=vercel-production,sentry-release=4448848c4d7e604a104f0985b715351b4be937a3,sentry-public_key=9ac72b56f8416f2677e217678b32a061,sentry-trace_id=${traceId}`;
    headers['sentry-trace'] = `${traceId}-${spanId}`;

    try {
        const response = await axios({
            method: 'POST',
            url,
            headers,
            data: compressedBody,
            responseType: 'stream',
            timeout: 60000,
            decompress: false,
        });

        console.log('响应状态:', response.status);
        console.log('\nSSE 响应:\n');

        const stream = response.data;
        let buffer = '';

        return new Promise((resolve, reject) => {
            stream.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim()) {
                        console.log(line);
                    }
                }
            });

            stream.on('end', () => {
                if (buffer.trim()) console.log(buffer);
                console.log('\n=== 完成 ===');
                resolve();
            });

            stream.on('error', reject);
        });

    } catch (error) {
        console.error('发送消息失败:', error.message);
        if (error.response) {
            console.error('响应状态:', error.response.status);
            const chunks = [];
            error.response.data.on('data', chunk => chunks.push(chunk));
            error.response.data.on('end', async () => {
                const buffer = Buffer.concat(chunks);
                try {
                    const decompressed = await gunzip(buffer);
                    console.error('响应数据:', decompressed.toString());
                } catch (e) {
                    console.error('响应数据:', buffer.toString());
                }
            });
        }
        throw error;
    }
}

// 主函数
async function main() {
    const wosSession = 'Fe26.2*1*bf0a1e27973eeaf87f52c0592237f3f962bcafb578dde093b162af4cf24b5e72*nQ1h7-WAKceKzXD0QA4ooQ*XGiS_i4bBtY6B4mPe06juGyYqypL6PviFJW-PdS18WlARyjK36BBI9eAd-yEeTw1al2BgrEIk22q35Q08YWnygnR2AvskZGXt8SIQYTV4mtGm_cJWhCkMOZRZ9NGSlx4VZhyXZE4gCLFwm3d55zo_jXeDsROBTZ5YE_oFAJTS6SrKfzp8wLZJjqWaxfgGmDRwvg1QGm97xYtmObmJElZxVEbd7nHUwF9IdFNMDfVaMm7ADJ65VbaHZ3I6WfdUT2KRo4TGgArceoEZwhP1-xBbtgmlL4NEOSvrLGRAp2Ja8w690qIPFVOTtoqLBG_QczSk4uenBD0d16LsvyrbJAxDlSQXEovnJvSRZ0wHZrLLLsBlQmaV7UOebV6xTozMbPWX1RDG7PsWdT0VlprXNPhOHK22V_oT2xnkX6nAHepbKhmquapQ501pqxtHWa4hAekADc0dx-PtPFaYdmcOqIoEicBvGuPTEpurHQojl8nN7V45BzlgeY1GuhNQSJCj5TBihXn8Me2AJWYtE4daBXJow_3AZeoHhaxkR1I19CrQn-fijtLseMCJGdFILeBFGrILq9ivP0NAmL5eVpzusZe_fzDsD8DKj8Uz4eFx7-duNyuCdP5qbozKOo2YwpdHdlQoShTmDMU1oFZy-fJequUQN89o6WpkNIH2taVPruH0zLRp5mnrj8B81cIU9lM6jyxMkbHj3T7uIPnrWC0HBAOBZAMVjLktqKJmUO1nl8ob2SIxVdvDOzAzd4eUXHdzYqecL9kzKxCTJSz-OyOKcE9q38QWJFk0JNVaoHVY1ffF-CFXWysllINjlJBOJn8OPjNzG7bxshMf0JKpMO2GjdX-1Be3vnNA3ZSyUvaL57iLhX1hOFFFl1VFlKC4ajIwhUqpe8DMBPxUPC3zXNL8x9kX2X_QIWoQkInKyMwcYLZnnelJu8_xHnldVQKSxj8Izjz7d-3NSHRmDm9dlkmwMF59jb19pFYTuGZN8xs6dQMolwD6dBoKCT9VVNJg6TfpwNHMm41P0Mo6uLYS5gPLQL5xtPfS_OJd704ItfOAPi1bGGl-Bq4yUzLeXn9A_JGIt6zDPU3MqIw0u_fTOKB9uY2JZLRdr6JPiRYsOaxmDPLuTtocvovaOmuSHC9-kaaZkLugqxtLDo4o2Nid4_jfVmD2h6kUyjBzeGdt6y68yb0GcWnaJMpTgZDL8GXBo-B9FAVjayAiT-FlMuO_nvxifMWt3E0geZPHVXc7hRkg7uoSWTRgnOPAouQcJy8LEoIsASxZwgy88TH2uaiXQvg8UzssWWxP2Cwdx8_toVJTW8sEOX02SUxJ8VbTDdjJA86wblbvYZMGCagsK6sIMdrMpQGWdejZMhzeQA5nLpEv8TkMZqeEVfYJwOaiGRnvIkR5iCJ6uq7PoDChRfCBkrqGfSkvC5tlsIplQv0LQ1YQxnCyuv3n3hn354eCqVZNwe_7rU7-HsifriGODGBuhx0PqxfuayaKUtDiqliMjZyCbevN2r31CiWeqKZm52ui_926jsBsxJWpCGKwEoW3pbJSF6qEtRZcwpkKNCjlrERy7RITPKELw8mZgMgX3ivQ9oYbj243Qn2XZRFHRgGMOcmM5bmpDl9IeTUvu0cxBmIw3qQfZa2wZhpXGwRZt4AZsuX7bVm_Z2tDuEwJYat1g-iiu6o6w**aa84f4a0bf8ff728cf916f88c1966ffa548208d55741841fd80d85584e7b27d7*di6fu56picmvIMgzCdvLCqYiMdjkQ3bQn3Cqv45IVHg~2';

    // 使用抓包中的 cwd
    const cwd = '/Users/liumingkang/AI/CeshiAI';
    const title = 'CeshiAI';

    try {
        // 先测试 session 是否有效
        console.log('=== 测试 Session 有效性 ===');
        const sessionUrl = 'https://app.ami.dev/api/v1/trpc/user.session.get';
        const sessionHeaders = {
            'host': 'app.ami.dev',
            'user-agent': USER_AGENT,
            'accept': '*/*',
            'cookie': `wos-session=${wosSession}`,
        };

        try {
            const sessionResp = await axios.get(sessionUrl, { headers: sessionHeaders });
            console.log('Session 响应:', JSON.stringify(sessionResp.data, null, 2).substring(0, 500));
        } catch (e) {
            console.log('Session 检查失败:', e.message);
            if (e.response) {
                console.log('状态码:', e.response.status);
            }
        }

        // 步骤1: 创建 project
        const { projectId, chatId } = await createProject(wosSession, cwd, title);

        // 等待一下
        console.log('等待 1 秒...');
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 步骤2: 发送消息
        await sendMessage(wosSession, projectId, chatId, '你好，你是什么模型？', cwd);

    } catch (error) {
        console.error('测试失败:', error.message);
    }
}

main();
