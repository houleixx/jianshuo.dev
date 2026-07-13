// VoiceDrop 的 MCP 工具表。
//
// 每个工具 = {name, description, inputSchema, handler(args, {client})}。
// description 是写给模型看的——它只有这几行字来决定要不要调、怎么调，
// 所以该说的领域知识（算力单位、stem 是什么、[[photo:]] 标记）都写在里面。
//
// 有意不做：音频/照片的二进制上传下载。几 MB 的 base64 塞进模型上下文是灾难，
// App 已经干得很好。这里只给「列出」和「拿公开 URL」。

import { FILES_ORIGIN } from "./vd-client.js";

const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });

const STEM = str(
  "文章的 stem（不含扩展名的文件名，形如 VoiceDrop-2026-07-13-143052-...）。用 list_articles 拿。",
);
const SHARE_ID = str("社区帖子的 shareId（12 位）。用 community_feed 拿。");

export const TOOLS = [
  // ─────────────────────────── 文章 ───────────────────────────
  {
    name: "list_articles",
    description:
      "列出我的全部文章（最新在前）。返回每篇的 stem、标题、当前版本号 head、节数 count、创建/更新时间。" +
      "这是所有文章操作的入口——先用它拿 stem。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.files("GET", "articles"),
  },
  {
    name: "read_article",
    description:
      "读一篇文章的全文。返回 articles[{title, body}]（body 是 Markdown 正文）、口述原文 transcript、" +
      "以及元数据。正文里的 [[photo:photos/...]] 是内嵌照片标记，要展示的话用 photo_url 换成可访问的 URL。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) => client.files("GET", ["articles", stem]),
  },
  {
    name: "write_article",
    description:
      "写一篇文章：stem 已存在就改写，是新的就新建。这是版本化写入：每次写都追加一个新版本、" +
      "head 前移，旧版本还在（可用 article_history 看、set_article_version 撤销）。新建时会自动补一个" +
      "静音占位录音，文章才会出现在「我的录音」里。注意：正文里已有的 [[photo:...]] 标记要原样保留，" +
      "否则照片会从文章里消失。",
    inputSchema: obj(
      {
        stem: STEM,
        articles: {
          type: "array",
          description: "新的文章内容。一次录音可以出多篇，所以这是数组。",
          items: obj({ title: str("标题"), body: str("Markdown 正文") }, ["title", "body"]),
        },
      },
      ["stem", "articles"],
    ),
    handler: ({ stem, articles }, { client }) =>
      client.files("PUT", ["articles", stem], { body: { articles } }),
  },
  {
    name: "article_history",
    description: "看一篇文章的版本历史（最多保留 10 版）。返回当前 head 和每个版本的内容、保存时间、来源。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) => client.files("GET", ["articles", stem, "history"]),
  },
  {
    name: "set_article_version",
    description:
      "撤销/重做：把文章的 head 指针挪到指定版本。只移指针，不产生新版本。版本号从 article_history 拿。",
    inputSchema: obj({ stem: STEM, head: int("要切到的版本号") }, ["stem", "head"]),
    handler: ({ stem, head }, { client }) =>
      client.files("PATCH", ["articles", stem, "head"], { body: { head } }),
  },
  {
    name: "delete_article",
    description:
      "删除一篇文章，连同它的 .srt/.empty/.blocked 边车。不会删掉原始录音——录音还在，下次挖矿会重新成文。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) => client.files("DELETE", ["articles", stem]),
  },

  // ─────────────────────────── 文风 ───────────────────────────
  {
    name: "read_style",
    description:
      "读我的写作风格。挖矿时这份会被叠进 system prompt，决定文章写成什么样。" +
      "返回当前 style 正文、名字 name、版本 head。如果 default:true，说明还没自定义过，用的是默认风格。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.files("GET", "style"),
  },
  {
    name: "write_style",
    description:
      "改写我的写作风格（版本化，同文章）。风格描述要写成可执行的规则——" +
      "「单句成段，段落 1–3 句居多」这种模型能照做的，而不是「喜欢短句」这种模糊的。改完下次挖矿自动生效。",
    inputSchema: obj({ style: str("风格正文（Markdown）"), name: str("我的名字（可选）") }, ["style"]),
    handler: ({ style, name }, { client }) =>
      client.files("PUT", "style", { body: name === undefined ? { style } : { style, name } }),
  },
  {
    name: "style_history",
    description: "看写作风格的版本历史。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.files("GET", "style/history"),
  },
  {
    name: "set_style_version",
    description: "撤销/重做写作风格：把 head 挪到指定版本，不产生新版本。",
    inputSchema: obj({ head: int("要切到的版本号") }, ["head"]),
    handler: ({ head }, { client }) => client.files("PATCH", "style/head", { body: { head } }),
  },
  {
    name: "collect_style_sample",
    description:
      "往风格语料库里加一篇样本（我以前写的东西）。攒够语料后用 extract_style 一次性蒸馏成写作风格。",
    inputSchema: obj(
      { text: str("样本全文"), title: str("样本标题（可选）"), type: str("样本类型（可选）") },
      ["text"],
    ),
    handler: ({ text, title, type }, { client }) =>
      client.files("POST", "style/collect", { body: { text, title, type } }),
  },
  {
    name: "list_style_dataset",
    description: "列出风格语料库里已有的样本（只有元数据，不含正文）。返回总条数和总字数。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.files("GET", "style/dataset"),
  },
  {
    name: "extract_style",
    description:
      "从语料库蒸馏出写作风格：服务端读完 collect_style_sample 攒的全部样本，提炼成一份新的写作风格" +
      "（写成新版本），并生成一篇「风格介绍」文章。语料太少会报错。这一步花算力。",
    inputSchema: obj({
      clearAfter: { type: "boolean", description: "蒸馏完是否清空语料库（默认否）" },
    }),
    handler: ({ clearAfter }, { client }) =>
      client.agent("POST", "style/extract", { body: { clearAfter: !!clearAfter } }),
  },

  // ─────────────────────────── 挖矿 ───────────────────────────
  {
    name: "trigger_mining",
    description:
      "催一下挖矿：把还没成文的录音立刻处理掉（ASR → 大模型写文章）。平时上传录音会自动触发，" +
      "这个是加急用的。异步——返回后过一会儿再 list_articles 看结果。花算力。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.agent("POST", "mine/trigger"),
  },
  {
    name: "restyle_article",
    description:
      "用写作风格重写一篇已有文章：从它存下来的口述原文重新生成，套上指定版本的风格。" +
      "结果写成新版本（head 前移），可以用 set_article_version 撤回。不给 styleV 就用当前风格。花算力。",
    inputSchema: obj({ stem: STEM, styleV: int("风格版本号（可选，默认当前）") }, ["stem"]),
    handler: ({ stem, styleV }, { client }) =>
      client.agent("POST", "restyle", { body: styleV === undefined ? { stem } : { stem, styleV } }),
  },

  // ─────────────────────────── 社区 ───────────────────────────
  {
    name: "community_feed",
    description:
      "看社区列表：别人分享出来的文章，带推荐排序、点赞数、回复数、我有没有投过币。" +
      "返回 posts[] 和推荐顺序 order[]。要看某帖全文用 read_community_post。",
    inputSchema: obj({}),
    handler: async (_a, { client }) => {
      try {
        return await client.reco("GET", "feed");
      } catch (e) {
        // reco worker 没设 SESSION_SECRET，只认 anon_ token——Apple session JWT
        // 打过去必然 401。D1 挂了则是 503。这两种情况回退到核心的时间序列表，
        // 正是 app 自己的兜底策略（reco/wrangler.jsonc 开头就写着）。
        // 500 之类是真故障，不吞。
        if (e.status !== 401 && e.status !== 503) throw e;
        const out = await client.files("GET", "community/list");
        return { ...out, fallback: true, fallbackReason: `reco 不可用（${e.status}），退回时间序列表` };
      }
    },
  },
  {
    name: "read_community_post",
    description:
      "读一个社区帖子的全文。内容是实时从原文章读的——作者改了文章，这里立刻跟着变。" +
      "返回里的 owner + [[photo:...]] 标记可以拼给 photo_url 换成图片 URL。",
    inputSchema: obj({ shareId: SHARE_ID }, ["shareId"]),
    handler: ({ shareId }, { client }) => client.files("GET", ["community", "get", shareId]),
  },
  {
    name: "community_replies",
    description: "看一个社区帖子下面的回复（社区是一层扁平线程，回复不再嵌套）。",
    inputSchema: obj({ shareId: SHARE_ID }, ["shareId"]),
    handler: ({ shareId }, { client }) => client.files("GET", ["community", "replies", shareId]),
  },
  {
    name: "share_to_community",
    description:
      "把我的一篇文章分享到社区。带 replyTo 就是作为某个帖子的回复发出去。" +
      "同一篇文章重复分享 = 原地更新，不会刷屏。需要 Apple 或微信登录后的身份（匿名 token 会被拒）。",
    inputSchema: obj({ stem: STEM, replyTo: str("要回复的帖子 shareId（可选）") }, ["stem"]),
    handler: ({ stem, replyTo }, { client }) =>
      client.files("POST", ["community", "share", "articles", `${stem}.json`], {
        body: replyTo === undefined ? {} : { replyTo },
      }),
  },
  {
    name: "unshare_from_community",
    description: "把我分享到社区的帖子撤回。只能撤自己的。需要 Apple 或微信登录后的身份。",
    inputSchema: obj({ shareId: SHARE_ID }, ["shareId"]),
    handler: ({ shareId }, { client }) => client.files("POST", ["community", "unshare", shareId]),
  },
  {
    name: "is_shared",
    description: "查我的某篇文章有没有分享到社区，分享了的话 shareId 是多少。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) =>
      client.files("GET", ["community", "shared", "articles", `${stem}.json`]),
  },
  {
    name: "feed_coin",
    description:
      "给社区里的一篇文章投币（点赞的强化版）：铸出金币，作者和投币人双方都拿到算力。" +
      "同一篇文章每人只能投一次。需要 Apple 或微信登录后的身份。",
    inputSchema: obj({ shareId: SHARE_ID }, ["shareId"]),
    handler: ({ shareId }, { client }) => client.agent("POST", "feed", { body: { share_id: shareId } }),
  },

  // ─────────────────────────── 算力 ───────────────────────────
  {
    name: "credit_balance",
    description:
      "查算力余额。算力是 VoiceDrop 的计费单位，23 算力 = 1 元。挖矿、改稿、蒸馏文风都花算力。" +
      "返回 suanli（余额）、yuan（折合人民币）、granted_suanli（累计获得）、spent_suanli（累计花掉）。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.agent("GET", "usage/balance"),
  },
  {
    name: "credit_ledger",
    description:
      "查算力流水（每一笔收支）。kind 是 grant（获得）或 spend（花掉），reason 说明是干什么花的" +
      "（挖矿 / 改稿 / 语音识别 / 投币 / 邀请…）。",
    inputSchema: obj({
      limit: int("要几条（默认 50）"),
      before: str("翻页游标，从上一页的 next 拿"),
    }),
    handler: ({ limit, before }, { client }) =>
      client.agent("GET", "usage/ledger", { query: { limit: limit ?? 50, before } }),
  },
  {
    name: "credit_summary",
    description: "算力收支汇总：按用途分组，看清楚算力都从哪来、花到哪去了。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.agent("GET", "usage/summary"),
  },

  // ─────────────────────────── 发布 ───────────────────────────
  {
    name: "share_link",
    description: "给一篇文章生成公开分享链接（voicedrop.cn/<id>，任何人无需登录都能看）。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) => client.files("GET", ["share", "articles", `${stem}.json`]),
  },
  {
    name: "publish_wechat",
    description:
      "把一篇文章发到我的微信公众号草稿箱（同步执行，返回时草稿已经在了）。" +
      "需要先在 App 设置里配好公众号的 appid 和 secret。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) => client.files("POST", ["wechat", "articles", `${stem}.json`]),
  },
  {
    name: "xhs_pack",
    description: "把一篇文章改写成小红书文案（配上图片 key）。花算力。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) => client.agent("POST", "xhs-pack", { body: { stem } }),
  },

  // ────────────────────── 媒体与身份 ──────────────────────
  {
    name: "whoami",
    description: "我是谁：返回当前 token 对应的账号 scope。用来确认 token 有效、以及自己是哪个账号。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.files("GET", "whoami"),
  },
  {
    name: "list_files",
    description:
      "列出我账号下的文件。kind=audio 只看录音（VoiceDrop-*.m4a），kind=photos 只看照片，不给就全列。" +
      "录音有没有成文，看 list_articles 里有没有同名 stem。",
    inputSchema: obj({
      kind: { type: "string", enum: ["all", "audio", "photos"], description: "过滤（默认 all）" },
    }),
    handler: async ({ kind = "all" }, { client }) => {
      const out = await client.files("GET", "list");
      if (kind === "all") return out;
      const keep =
        kind === "audio"
          ? (n) => n.endsWith(".m4a")
          : (n) => n.startsWith("photos/") || n.includes("/photos/");
      return { ...out, files: (out.files ?? []).filter((f) => keep(f.name)) };
    },
  },
  {
    name: "photo_url",
    description:
      "把照片标记换成公开可访问的图片 URL。文章正文里的 [[photo:photos/xxx.jpg]]，" +
      "photos/xxx.jpg 就是这里的 key；owner 从 read_community_post 的返回里拿，自己的文章用 whoami 的 scope。" +
      "拼出来的 URL 无需 token，可以直接给出去。",
    inputSchema: obj(
      {
        owner: str("账号 scope，形如 users/anon-abc/"),
        key: str("照片的相对 key，形如 photos/2026-07-13-120000/5-x9q.jpg"),
      },
      ["owner", "key"],
    ),
    // 纯计算，不打网络。
    handler: async ({ owner, key }) =>
      `${FILES_ORIGIN}/files/api/photo/${owner.replace(/\/$/, "")}/${key.replace(/^\//, "")}`,
  },
];
