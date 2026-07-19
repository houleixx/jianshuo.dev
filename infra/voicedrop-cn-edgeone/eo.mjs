// 极简腾讯云 API 调用器(teo 专用,无依赖,TC3-HMAC-SHA256 签名)。
// 用法:
//   export TENCENTCLOUD_SECRET_ID=... TENCENTCLOUD_SECRET_KEY=...
//   node eo.mjs <Action> '<json-payload>'
// 例:
//   node eo.mjs DescribeZones '{}'
//   node eo.mjs CreateZone '{"Type":"partial","ZoneName":"voicedrop.cn","Area":"global","PlanId":"edgeone-xxxx"}'
// 建议用 CAM 子账号密钥,仅授权 QcloudTEOFullAccess,部署完即回收。
import crypto from 'node:crypto';

const SECRET_ID = process.env.TENCENTCLOUD_SECRET_ID;
const SECRET_KEY = process.env.TENCENTCLOUD_SECRET_KEY;
const HOST = 'teo.tencentcloudapi.com';
const SERVICE = 'teo';
const VERSION = '2022-09-01';

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, s, hex) =>
  crypto.createHmac('sha256', key).update(s, 'utf8').digest(hex ? 'hex' : undefined);

async function call(action, payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload ?? {});

  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\nhost:${HOST}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256hex(body)}`;

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256hex(canonicalRequest)}`;

  const kDate = hmac(`TC3${SECRET_KEY}`, date);
  const kService = hmac(kDate, SERVICE);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = hmac(kSigning, stringToSign, true);

  const authorization =
    `TC3-HMAC-SHA256 Credential=${SECRET_ID}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${HOST}/`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': VERSION,
    },
    body,
  });
  const json = await res.json();
  if (json.Response?.Error) {
    console.error(`ERROR ${json.Response.Error.Code}: ${json.Response.Error.Message}`);
    process.exit(1);
  }
  console.log(JSON.stringify(json.Response, null, 2));
}

const [action, payload] = process.argv.slice(2);
if (!action || !SECRET_ID || !SECRET_KEY) {
  console.error('usage: TENCENTCLOUD_SECRET_ID=... TENCENTCLOUD_SECRET_KEY=... node eo.mjs <Action> [json]');
  process.exit(2);
}
await call(action, payload ? JSON.parse(payload) : {});
