# VoiceDrop API

The VoiceDrop backend is made up of **three independent HTTP services**, all running on Cloudflare under the same `jianshuo.dev` zone. A client typically only talks to the first two.

| Service | Base URL | Purpose |
|---|---|---|
| **Files API** | `https://jianshuo.dev/files/api/` | Accounts, recording/article files, sharing, WeChat Official Account, community. The vast majority of calls go here. |
| **Agent Worker** | `https://jianshuo.dev/agent/` (WS: `wss://jianshuo.dev/agent/`) | Trigger mining, real-time status push, voice-driven editing. |
| **Reco Worker** | `https://jianshuo.dev/reco/` | Community feed ranking + engagement reporting. Can be unplugged at any time; if it's down, the main flow is unaffected. |

> Each service also has a `*.jianshuo.workers.dev` mirror (`voicedrop-agent.jianshuo.workers.dev`, `voicedrop-reco.jianshuo.workers.dev`) with identical behavior. Server-to-server calls within the same zone use the mirror to bypass Pages routing; clients should just use the `jianshuo.dev/...` URLs above.

**The data flow in one sentence**: upload `.m4a` → server-side mining (ASR + Claude) writes out `articles/<stem>.json` → client reads articles, shares them, publishes to WeChat Official Account / community.

---

## 1. Authentication

All requests use `Authorization: Bearer <token>` (the Files API also accepts a `?token=<token>` query parameter). There are two tiers of credentials:

| Credential | Shape | How to get it | scope (data isolation) |
|---|---|---|---|
| **anon token** | High-entropy string starting with `anon_`, ≥20 chars | Client generates it once and keeps it (the same user always uses the same token) | `users/anon-<sha256(token)[:32]>/` |
| **session JWT** | `h.p.sig` (HS256) | Exchange an Apple identityToken via `POST auth/apple` | `scope` inside the JWT |

**Key points:**
- **scope decides whose data you can see.** All your relative keys are automatically joined under the `scope` prefix; there is no way to escape it (`..` and absolute paths are always rejected).
- **anon and session resolve to the same user.** Apple sign-in merely *binds* the Apple ID to your current anon data box — the session's scope is itself `users/anon-<hash>/`. So whether a user calls with anon or session, it lands on the same data.
- **Most endpoints accept any valid token.** Only **community writes (share / unshare)** require an Apple-verified session JWT; otherwise `403 needs_apple_signin`.
- There is also a 24h **read-only temp token** (issued by `GET token/articles`) that can only `list` / `download`. Reco and Agent do **not accept** temp tokens.

### Exchanging for a session JWT

```
POST /files/api/auth/apple
Content-Type: application/json

{ "identityToken": "<Apple identity token>", "fullName": "Zhang San", "email": "..." }
```
`fullName` / `email` are only provided by Apple on first authorization and are optional. If you include your current anon token (in the `Authorization` header), the Apple ID gets bound to that anon box and your data stays put.

Returns: `{ "session": "<JWT, valid for 365 days>", "scope": "users/<sub>/" }`

---

## 2. General conventions

- **Request / response bodies are JSON** (except file upload / download).
- **Errors**: any non-2xx returns `{ "error": "<code>", ... }`. Common status codes:

  | Code | Meaning |
  |---|---|
  | 400 | Invalid parameter / key |
  | 401 | Token missing or invalid |
  | 403 | Insufficient permission (read-only token overreach, not the owner, community write without Apple sign-in) |
  | 404 | Resource not found |
  | 409 | Not configured (e.g. WeChat Official Account missing AppID/Secret → `wechat_not_configured`) |
  | 502 | Upstream failure (WeChat Official Account relay / real WeChat errcode passed through) |

- **Path conventions** (easy to mix up — read carefully):

  | Endpoint family | Identifier you pass | Example |
  |---|---|---|
  | File endpoints (`list`/`download`/`upload`/`file`) | **Relative path within scope** | `VoiceDrop-xxx.m4a`, `articles/xxx.json` |
  | `share` / `wechat` / `community/*` | **Relative article key** | `articles/<stem>.json` |
  | Articles API (`/articles/...`) | **stem** (bare filename, no `articles/` prefix, no `.json`) | `VoiceDrop-xxx` |
  | `photo` / `asset` (public) | **Full R2 key** | `users/<sub>/photos/.../x.jpg` |

---

## 3. Files API

> Everything requires a token except `auth/apple`, `photo/*`, and `asset/wechat-covers/*`.

### Account

| Method / path | Description | Returns |
|---|---|---|
| `POST auth/apple` | See above | `{session, scope}` |
| `GET whoami` | The scope resolved from the current token | `{scope:"users/<sub>/"}` |
| `GET token/articles` | Issue a 24h read-only articles link | `{token, url, expires_in:86400}` |

### Files (raw R2 read/write)

| Method / path | Description | Returns |
|---|---|---|
| `GET list` | List all objects within scope (pagination is aggregated, never truncated) | `{files:[{name,size,uploaded}]}` |
| `PUT upload/<name>` | Upload (request body is the raw file bytes, `Content-Type` passed through). **When `name` looks like `VoiceDrop-*.m4a`, mining is triggered automatically.** | `{ok:true, name}` |
| `GET download/<name>` | Download raw bytes. `HEAD` on the same path fetches metadata only. | File bytes |
| `DELETE file/<name>` | Delete a single object | `{ok:true}` |

**Recording filename convention**: `VoiceDrop-<ts>-<dur>-<weekday>-<period>[-<city>-<district>].m4a` (pure ASCII). Only this prefix + suffix triggers automatic mining.

### Articles (high-level CRUD, versioned)

`<stem>` = the recording filename with its extension removed. **Prefer this set of endpoints over raw `download/articles/<stem>.json`** — it flattens the internal version structure (`versions[head]`) into a top-level `articles`.

| Method / path | Description | Returns |
|---|---|---|
| `GET articles` | List all articles | `{articles:[{stem,title,head,createdAt,updatedAt,count}]}` |
| `GET articles/<stem>` | Read one (current head version) | Article document (see §6) |
| `PUT articles/<stem>` | Write (automatically saved as a new version) | `{ok, head}` |
| `DELETE articles/<stem>` | Delete the article + `.srt` + `.empty` sidecars | `{ok}` |
| `GET articles/<stem>/history` | Version history | `{head, versions:[...]}` |
| `PATCH articles/<stem>/head` | Move only the head pointer (undo / redo, no new version created), body `{head:<n>}` | `{ok, head}` |
| `PUT articles/<stem>/srt` | Write the subtitle sidecar (request body is SRT text) | `{ok}` |
| `PUT articles/<stem>/empty` | Mark as no speech, body `{reason?}` | `{ok}` |

### Writing style (versioned)

The mining / editing prompts layer in the user's writing style. Storage is a versioned `CLAUDE.json` (schema-3, same `versions[head]` structure as articles). **The writing style is the only versioned field**; **identity fields like the name live in the non-versioned `doc.profile`** (renaming does not create a new style version). On read, it falls back to the "# My name" line in the legacy `CLAUDE.md`.

| Method / path | Description | Returns |
|---|---|---|
| `GET style` | Read the current writing style + name | `{style, name, head, createdAt, updatedAt}`; with only a legacy `CLAUDE.md`: `{style, name, head:0, legacy:true}`; neither exists → `404` |
| `PUT style` | Write. Body `{style?, name?, source?}`: pass `style` to save as a new version; pass `name` to update only `profile.name` (**no new version**); both may be passed together | `{ok, head}`; both `style` and `name` empty → `400 empty_content` |
| `GET style/history` | Version history | `{head, versions:[{v,savedAt,source,style}]}` (oldest-first, max 10 versions) |
| `PATCH style/head` | Move only the head pointer (undo / redo, no new version created), body `{head:<n>}` | `{ok, head}`; version not found → `404` |

### Sharing & WeChat Official Account

| Method / path | Description | Returns |
|---|---|---|
| `GET share/articles/<stem>.json` | Create / fetch the public short link for this article | `{url:"https://jianshuo.dev/voicedrop/<id>"}` |
| `POST wechat/articles/<stem>.json` | **Synchronously** publish the article as a WeChat Official Account draft (updates in place if already published). Requires `WECHAT.json` to be configured first. | `{ok,created,updated}`; `409 wechat_not_configured`; `502 {errcode,errmsg}` passes through the real WeChat error |

### Community (shared cross-user space)

A post is a **live pointer to an article** (schema-2, no content copy) — edit the source article and the community reflects it immediately.

| Method / path | Description | Returns |
|---|---|---|
| `POST community/share/articles/<stem>.json` | Share / re-share one of your own articles. Body may include `{replyTo:<shareId>}` to mark it as a reply. **Requires an Apple session**, otherwise `403 needs_apple_signin`. | `{ok, shareId}` |
| `GET community/list` | All posts, newest first by first-shared time | `{posts:[{shareId,author,title,firstSharedAt,count,mine,replyTo?}]}` |
| `GET community/get/<shareId>` | Read one post (with live article content) | `{shareId,author,title,articles:[{title,body}],owner,firstSharedAt,replyTo?}` |
| `GET community/replies/<shareId>` | Replies to a post, oldest first | `{posts:[...]}` |
| `GET community/shared/articles/<stem>.json` | Whether my article is already shared (drives the "Share / Update" button) | `{shared:bool, shareId?}` |
| `POST community/unshare/<shareId>` | Take down your own post (**owner only**) | `{ok}` |

> To render photos in a community post: join the returned `owner` with the key from each `[[photo:<relkey>]]` marker in the body to get the full key, then fetch it via the public `photo/<key>` endpoint below.

### Public assets (no token required)

| Method / path | Description |
|---|---|
| `GET photo/<full R2 key>` | Fetch a session photo. Only accepts `users/*/photos/*.(jpg\|jpeg\|png)`, CORS `*`, publicly cached. **All photo display goes through this single endpoint.** |
| `GET asset/wechat-covers` | List WeChat Official Account cover image names → `{covers:[...]}` |
| `GET asset/wechat-covers/<name>` | Fetch one cover image's bytes |

---

## 4. Agent Worker

Base: `https://jianshuo.dev/agent/`. Auth is the same as the Files API (anon or session; **editing requires a writable token**).

### Trigger mining

```
POST /agent/mine/trigger
Authorization: Bearer <any valid user token>
```
Wakes the server-side miner to process all pending recordings. Idempotent — already-processed ones are skipped. Returns `202 queued`. The server already calls this automatically on `.m4a` upload, so manual calls are rarely needed.

### `wss://…/agent/edit?stem=<stem>` — voice-driven editing

Once open it is a long-lived connection supporting multiple round trips; the server persists history per article, so context carries across turns.

**Client → server** (send an editing instruction):
```json
{
  "type": "instruct",
  "text": "Make line 3 more concise, and delete photo 2",
  "images": [
    { "data": "<base64>", "key": "photos/<sessionTs>/<offset>-<rand>.jpg", "mediaType": "image/jpeg" }
  ]
}
```
(`images` is optional, for attaching new photos.)

**Server → client** (pushed in order for each instruction):
```json
{ "type": "status",  "state": "working" }
{ "type": "updated", "article": { ... the full top-level articles document } }
{ "type": "reply",   "text": "Done", "ok": true }
{ "type": "error",   "message": "<reason>" }
```
- `status`: processing started.
- `updated`: written back to R2 — use it to refresh in place.
- `reply`: verbal confirmation (`text` may be empty).
- `error`: failed; this instruction did not take effect.

**Protocol rules (clients must follow):**
- **Strictly serial**: do not send the next `instruct` until the previous one has received `updated`. If the server is busy it replies `{"type":"error","message":"正在修改，请稍候"}` ("editing in progress, please wait").
- A successful instruction always goes `status` → then `updated` → (usually) `reply`. Once you receive `updated`, the article for this turn is persisted.
- A `[[photo:<key>]]` marker in the body = a photo placement; the key is the photo's relative R2 key. Edits preserve these markers verbatim.
- Users may refer to positions as "line N / photo N": line N = the Nth non-empty line after splitting the body on real newlines (a photo marker occupies its own line); photo N = the Nth photo marker appearing in the body.

### `wss://…/agent/status` — real-time status push

Read-only subscription; **the client sends no messages**. Whenever a recording's status changes, the server pushes:
```json
{ "type": "status_update", "stem": "VoiceDrop-xxx", "status": "asr" }
```
`status` values: `asr` (listening to the recording) · `mining` (mining articles) · `ready` (article ready) · `empty` (no speech). Use this to flip list-row badges in place, no polling needed.

---

## 5. Reco Worker

Base: `https://jianshuo.dev/reco/`. Auth: anon or session token (temp tokens are **not accepted**). Unpluggable — **clients should use a 2s timeout of their own; if reco is down or times out, fall back to reverse-chronological order** and the feed still works.

### `POST /reco/rank` — feed ranking

Hand the posts from `GET community/list` to reco for ranking. Request:
```json
{ "posts": [ { "shareId":"abc", "firstSharedAt":1700000000000, "replyCount":2, "author":"Zhang San" } ] }
```
Returns:
```json
{ "order": ["<shareId>", "..."],
  "liked": ["<shareId>", "..."] }
```
`order` = the shareIds in ranked order; `liked` = the ones the current user has ❤️'d. Score = `(1 + view·1 + finish·4 + like·3 + reply·5 + report·(-9)) / (ageHours+2)^1.5`, then interleaved by author.

### `POST /reco/engage/<shareId>` — engagement reporting (fire-and-forget)

```json
{ "action": "view" }
```
`action` ∈ `view` (opened the post) · `finish` (read to the end) · `like` (❤️) · `report` (report).
- Deduplicated per user per action; `view` / `finish` / `report` are one-shot, never accumulated.
- **`like`** with `{"action":"like","on":false}` means un-like; returns `{ok, liked:<bool>}`. Everything else returns `{ok}`.
- **`report`** is irrevocable and negatively weighted; a single report can sink a cold-start post to the bottom.
- If D1 is unavailable, everything degrades to a no-op — it never errors.

---

## 6. Data model

### Article document (returned by `GET articles/<stem>`)

```json
{
  "schema": 3,
  "id": "VoiceDrop-xxx",
  "sourceAudio": "VoiceDrop-xxx.m4a",
  "createdAt": 1700000000000,
  "updatedAt": 1700000000000,
  "transcript": "Raw dictation transcript…",
  "srt": "1\n00:00:00,000 --> ...",
  "status": "ready",
  "model": "claude-sonnet-4-6",
  "articles": [ { "title": "Title", "body": "Body markdown, with [[photo:<relkey>]] markers" } ]
}
```
- **`articles` is the current head version, flattened**; the internal `versions` / `head` are not returned here (use `/history`).
- An article **exists** = `articles/<stem>.json` exists = the article is ready.
- Processed but **no speech** = the same directory has `articles/<stem>.empty` (`{status:"empty",reason:"..."}`).
- **Photos** are referenced only via `[[photo:<relkey>]]` markers in the body; there is no separate photos array. `<relkey>` is a relative key within scope — prepend the `users/<sub>/` prefix from `whoami` / `owner` to get the full key, then fetch via the public `photo/<key>` endpoint.

### R2 key cheat sheet (all under `users/<sub>/`)

| key | Contents |
|---|---|
| `VoiceDrop-<ts>-….m4a` | Recording (uploading it triggers mining) |
| `articles/<stem>.json` | Article (exists = ready) |
| `articles/<stem>.empty` | No-speech marker |
| `articles/<stem>.srt` | Subtitle sidecar |
| `photos/<sessionTs>/<offset>-<rand>.jpg` | Session photo (`<offset>` = whole seconds from the start of the recording) |
| `CLAUDE.json` | Writing style (versioned schema-3, fed into the mining/editing prompts) — see the "Writing style" endpoints above |
| `CLAUDE.md` | Stores only the user's name (legacy style fallback source; writes go to `CLAUDE.json` only) |
| `WECHAT.json` | WeChat Official Account config `{appid,secret,enabled,coverMediaIds}` |

---

## 7. End-to-end example (cURL)

```bash
TOKEN="anon_xxxxxxxxxxxxxxxxxxxx"
BASE="https://jianshuo.dev/files/api"

# 1) Upload a recording (triggers mining automatically)
curl -X PUT "$BASE/upload/VoiceDrop-20260627-093012-Sat-morning.m4a" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: audio/m4a" \
  --data-binary @rec.m4a

# 2) (optional) Manually nudge the miner
curl -X POST "https://jianshuo.dev/agent/mine/trigger" \
  -H "Authorization: Bearer $TOKEN"

# 3) List articles, read one
curl "$BASE/articles" -H "Authorization: Bearer $TOKEN"
curl "$BASE/articles/VoiceDrop-20260627-093012-Sat-morning" -H "Authorization: Bearer $TOKEN"

# 4) Create a public share link
curl "$BASE/share/articles/VoiceDrop-20260627-093012-Sat-morning.json" \
  -H "Authorization: Bearer $TOKEN"

# 5) Publish as a WeChat Official Account draft (configure WECHAT.json first)
curl -X POST "$BASE/wechat/articles/VoiceDrop-20260627-093012-Sat-morning.json" \
  -H "Authorization: Bearer $TOKEN"
```

For live progress, subscribe to `wss://jianshuo.dev/agent/status` (with the same `Authorization`) and watch this recording's badge flip from `asr` → `mining` → `ready`.
