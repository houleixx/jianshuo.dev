/* ============================================================
   太平洋战争 1941–1945 · 互动逻辑
   ============================================================ */
"use strict";

const IMG = f => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(f)}?width=1000`;

/* ───────────── 数据：时间轴 ───────────── */
const TIMELINE = [
  { date: "1941.12.07", side: "jp", title: "偷袭珍珠港", tag: "日本",
    text: "日本海军 6 艘航母派出 353 架飞机突袭夏威夷，重创美国太平洋舰队战列舰群。美国次日对日宣战，太平洋战争爆发。" },
  { date: "1941.12", side: "jp", title: "席卷东南亚", tag: "日本",
    text: "日军同期进攻菲律宾、马来亚、香港、关岛与威克岛，势如破竹，半年内控制西太平洋与东南亚。" },
  { date: "1942.04.18", side: "us", title: "杜立特空袭东京", tag: "盟军",
    text: "16 架 B-25 从大黄蜂号航母起飞轰炸东京，军事损害有限，却极大鼓舞美国士气，并刺激日本发动中途岛作战。" },
  { date: "1942.05.04–08", side: "us", title: "珊瑚海海战", tag: "盟军",
    text: "史上首次航母对航母交战，双方舰队从未目视。日军被迫放弃进攻莫尔兹比港——盟军首次在战略上止住日本扩张。" },
  { date: "1942.06.04–07", side: "turn", title: "中途岛海战", tag: "转折点",
    text: "美军凭密码情报设伏，一日之内击沉日本四艘主力航母。日本海军损失精锐航母与飞行员，攻守易势——太平洋战争的转折点。" },
  { date: "1942.08–1943.02", side: "us", title: "瓜达尔卡纳尔战役", tag: "盟军",
    text: "盟军首次大规模反攻，围绕亨德森机场展开半年陆海空消耗战。日军最终撤退，战略主动权全面转移。" },
  { date: "1943–1944", side: "us", title: "跳岛进攻", tag: "盟军",
    text: "尼米兹中太平洋推进与麦克阿瑟西南太平洋推进双线展开，越过日军重兵据点直取关键岛屿，逐步逼近日本本土。" },
  { date: "1944.06", side: "us", title: "马里亚纳海战", tag: "盟军",
    text: "“马里亚纳猎火鸡”——日本航空兵被成批击落，损失三艘航母。塞班岛失守使 B-29 得以直接轰炸日本本土。" },
  { date: "1944.10.23–26", side: "us", title: "莱特湾海战", tag: "盟军",
    text: "史上规模最大的海战。日本海军主力几乎被全歼，神风特攻队首次大规模出动。日本作为海军强国的时代终结。" },
  { date: "1945.02.19–03.26", side: "us", title: "硫磺岛战役", tag: "盟军",
    text: "为 B-29 争夺前进机场。守军近乎全灭，美军伤亡惨重。折钵山升旗成为战争最著名的影像。" },
  { date: "1945.04.01–06.22", side: "us", title: "冲绳战役", tag: "盟军",
    text: "太平洋最血腥的战役，神风特攻与大和号自杀出击。逾 20 万人丧生（含大量平民），坚定了美国使用原子弹的决心。" },
  { date: "1945.08.06 / 08.09", side: "turn", title: "广岛与长崎原子弹", tag: "转折点",
    text: "8 月 6 日“小男孩”投向广岛，9 日“胖子”投向长崎。8 月 8 日苏联对日宣战出兵满洲，日本败局已定。" },
  { date: "1945.08.15", side: "turn", title: "玉音放送", tag: "转折点",
    text: "裕仁天皇通过广播宣布接受《波茨坦公告》，日本无条件投降。战火停息。" },
  { date: "1945.09.02", side: "us", title: "东京湾签降", tag: "盟军",
    text: "在停泊于东京湾的美国战列舰密苏里号上，日本代表签署投降书，第二次世界大战正式结束。" },
];

/* ───────────── 数据：关键战役 ───────────── */
const BATTLES = [
  { date: "1941 年 12 月 7 日", zh: "珍珠港事件", en: "Attack on Pearl Harbor",
    img: "Attack_on_Pearl_Harbor_Japanese_planes_view.jpg",
    outcome: "日本战术大胜", oc: "jp",
    text: "联合舰队的 6 艘航母在拂晓前对夏威夷瓦胡岛发动两波空袭。亚利桑那号战列舰弹药库殉爆沉没，1177 名官兵阵亡。日本以微小代价瘫痪了美国战列舰队——但港内未停泊任何美国航母，这成为日后命运的伏笔。",
    stats: [["8","战列舰被击沉/重创"],["2403","美军阵亡"],["29","日机损失"]] },

  { date: "1942 年 5 月 4–8 日", zh: "珊瑚海海战", en: "Battle of the Coral Sea",
    img: "Japanese_aircraft_carrier_Zuikaku_and_two_destroyers_under_attack.jpg",
    outcome: "盟军战略胜利", oc: "us",
    text: "人类史上第一次航母对航母的海战，敌对舰队全程未曾目视，全靠舰载机交手。美军失去列克星敦号，日军损失轻型航母祥凤号、翔鹤号受创、瑞鹤号航空队元气大伤。日本被迫取消对莫尔兹比港的海上进攻，扩张势头首次被遏止。",
    stats: [["1","美航母沉没（列克星敦）"],["1","日航母沉没（祥凤）"],["2","日军主力航母缺席中途岛"]] },

  { date: "1942 年 6 月 4–7 日", zh: "中途岛海战", en: "Battle of Midway",
    img: "SBD-3_Dauntless_bombers_of_VS-8_over_the_burning_Japanese_cruiser_Mikuma_on_6_June_1942.jpg",
    outcome: "战争转折点", oc: "turn",
    text: "美军密码部门破译日军 JN-25 电码，预知了中途岛作战计划。当南云的航母正在甲板上换装弹药时，美军 SBD 无畏式俯冲轰炸机自高空扑下，几分钟内重创赤城、加贺、苍龙三舰，当日飞龙亦被击沉。日本一举失去四艘主力航母和大批身经百战的飞行员。",
    stats: [["4","日航母被击沉"],["1","美航母沉没（约克城）"],["~3000","日军阵亡"]] },

  { date: "1942.08 – 1943.02", zh: "瓜达尔卡纳尔战役", en: "Guadalcanal Campaign",
    img: "Marines_rest_in_the_field_on_Guadalcanal.jpg",
    outcome: "盟军胜利", oc: "us",
    text: "中途岛后，盟军在所罗门群岛发动首次大规模反攻，目标是争夺亨德森机场。围绕这座岛屿展开了长达半年的丛林、海上与空中消耗战，“东京快车”夜间运输与多次惨烈海战交织。日军最终被迫撤离，太平洋战场的主动权彻底易手。",
    stats: [["6","个月鏖战"],["~7100","盟军阵亡"],["~31000","日军阵亡/失踪"]] },

  { date: "1944 年 10 月 23–26 日", zh: "莱特湾海战", en: "Battle of Leyte Gulf",
    img: "Kamikaze_zero.jpg",
    outcome: "盟军决定性胜利", oc: "us",
    text: "为阻止盟军重返菲律宾，日本孤注一掷发动“捷一号”作战，几乎倾巢而出。这场史上最大规模的海战中，日本损失了包括巨型战列舰武藏号在内的大批舰艇，海军主力近乎覆灭。也正是在此役，神风特攻队首次成建制出击——绝望的信号。",
    stats: [["~4","场连续大海战"],["1","武藏号战列舰沉没"],["首次","神风特攻大规模出动"]] },

  { date: "1945 年 2 月 19 日 – 3 月 26 日", zh: "硫磺岛战役", en: "Battle of Iwo Jima",
    img: "Raising_the_Flag_on_Iwo_Jima,_larger_-_edit1.jpg",
    outcome: "盟军惨胜", oc: "us",
    text: "为给受损的 B-29 提供迫降机场，美军强攻这座火山岛。栗林忠道构筑的地下坑道工事让进攻者付出沉重代价。海军陆战队在折钵山顶竖起星条旗的照片，成为美国战争记忆中最具象征意义的画面。守军 2 万余人几乎全部战死。",
    stats: [["~6800","美军阵亡"],["~21000","日军阵亡"],["1","座关键机场"]] },

  { date: "1945 年 4 月 1 日 – 6 月 22 日", zh: "冲绳战役", en: "Battle of Okinawa",
    img: "USS_Bunker_Hill_hit_by_two_Kamikazes.jpg",
    outcome: "盟军胜利（代价极重）", oc: "us",
    text: "通往日本本土的最后一块跳板，也是太平洋最血腥的战役。日军以海量神风特攻冲击盟军舰队，巨舰大和号在自杀式出击中被击沉。逾 10 万平民在战火中丧生。惨烈的伤亡使盟军预估进攻本土将付出天文数字的代价——这成为动用原子弹的重要考量。",
    stats: [["~12500","盟军阵亡"],["~110000","日军阵亡"],[">100000","平民罹难"]] },

  { date: "1945 年 8 月 6 日 / 9 日", zh: "广岛与长崎", en: "Atomic Bombings",
    img: "Atomic_cloud_over_Hiroshima_-_NARA_542192_-_Edit.jpg",
    outcome: "战争走向终结", oc: "turn",
    text: "8 月 6 日，B-29“艾诺拉·盖伊”将“小男孩”投向广岛；三天后“胖子”投向长崎。两座城市在瞬间被摧毁，数十万人当场或后续死亡。与此同时，苏联于 8 月 8 日对日宣战、出兵满洲。多重打击之下，日本的抵抗意志彻底崩溃。",
    stats: [["2","座城市被毁"],["~20 万","直接与后续死亡"],["3","天间隔投弹"]] },

  { date: "1945 年 9 月 2 日", zh: "日本投降", en: "Surrender of Japan",
    img: "Surrender_of_Japan_-_USS_Missouri.jpg",
    outcome: "战争结束", oc: "us",
    text: "8 月 15 日，裕仁天皇通过广播宣布接受《波茨坦公告》。9 月 2 日上午，在停泊于东京湾的密苏里号战列舰甲板上，日本外相重光葵与参谋总长梅津美治郎代表日本签署投降书。麦克阿瑟主持受降——第二次世界大战至此正式落幕。",
    stats: [["1346","战争天数"],["1","纸投降书"],["1945","和平之年"]] },
];

/* ───────────── 数据：地图标记 ───────────── */
/* lat：纬度；lon：东经 0–360（西经记为 360−W） */
const MAP_POINTS = [
  { name: "珍珠港 Pearl Harbor", lat: 21.3, lon: 202.1, side: "jp",
    date: "1941.12.07", info: "夏威夷瓦胡岛。日本舰载机偷袭的目标，太平洋战争由此爆发。" },
  { name: "威克岛 Wake I.", lat: 19.3, lon: 166.6, side: "jp",
    date: "1941.12", info: "孤悬大洋的美军前哨，开战初期顽强抵抗后陷落。" },
  { name: "中途岛 Midway", lat: 28.2, lon: 182.6, side: "turn",
    date: "1942.06", info: "战争的转折点。美军在此设伏，一日击沉日本四艘主力航母。" },
  { name: "珊瑚海 Coral Sea", lat: -13, lon: 154, side: "us",
    date: "1942.05", info: "首次航母对决海域，盟军止住日军南下势头。" },
  { name: "瓜达尔卡纳尔 Guadalcanal", lat: -9.4, lon: 160.1, side: "us",
    date: "1942–43", info: "所罗门群岛。盟军首次大规模反攻，半年血战夺取亨德森机场。" },
  { name: "莱特湾 Leyte Gulf", lat: 11, lon: 125, side: "us",
    date: "1944.10", info: "菲律宾。史上最大海战，日本海军主力在此覆灭。" },
  { name: "马尼拉 Manila", lat: 14.6, lon: 121, side: "jp",
    date: "1942 / 1945", info: "菲律宾首都，1942 年陷落，1945 年经惨烈巷战收复。" },
  { name: "硫磺岛 Iwo Jima", lat: 24.8, lon: 141.3, side: "us",
    date: "1945.02", info: "火山列岛要点。折钵山升旗照片诞生地，守军近乎全灭。" },
  { name: "冲绳 Okinawa", lat: 26.3, lon: 127.8, side: "us",
    date: "1945.04", info: "通往本土的最后跳板，太平洋最血腥的战役。" },
  { name: "东京 Tokyo", lat: 35.7, lon: 139.7, side: "jp",
    date: "1942 / 1945", info: "日本首都。1942 年遭杜立特空袭，1945 年密苏里号在东京湾受降。" },
  { name: "广岛 Hiroshima", lat: 34.4, lon: 132.5, side: "turn",
    date: "1945.08.06", info: "第一颗实战原子弹“小男孩”的投放地。" },
  { name: "长崎 Nagasaki", lat: 32.7, lon: 129.9, side: "turn",
    date: "1945.08.09", info: "第二颗原子弹“胖子”的投放地，三天后日本走向投降。" },
];

/* ───────────── 数据：兵力对比 ───────────── */
const FORCES = {
  us: { title: "美国 / 盟军", en: "United States & Allies", rows: [
    { label: "战时新造各型航母", val: "≈150 艘", pct: 100 },
    { label: "战时飞机产量", val: "≈30 万架", pct: 100 },
    { label: "代表舰载战斗机", val: "F6F 地狱猫", pct: 78 },
    { label: "钢产量（1943，相对）", val: "压倒性", pct: 100 },
  ], note: "美国的真正武器是产能：船坞与工厂以日本无法追赶的速度，把损失补足并持续放大优势。" },
  jp: { title: "大日本帝国", en: "Empire of Japan", rows: [
    { label: "战时新造各型航母", val: "≈17 艘", pct: 12 },
    { label: "战时飞机产量", val: "≈7 万架", pct: 23 },
    { label: "代表舰载战斗机", val: "A6M 零式", pct: 70 },
    { label: "钢产量（1943，相对）", val: "约为美国 1/10", pct: 11 },
  ], note: "开战时日本舰队精锐、零式性能领先；但飞行员难以补充、工业基础薄弱，消耗战中迅速被拖垮。" },
};

/* ───────────── 数据：伤亡对比（阵亡估计值） ───────────── */
const CASUALTIES = [
  { name: "珍珠港", en: "Pearl Harbor", us: 2403, jp: 64 },
  { name: "中途岛", en: "Midway", us: 362, jp: 3057 },
  { name: "瓜达尔卡纳尔", en: "Guadalcanal", us: 7100, jp: 31000 },
  { name: "硫磺岛", en: "Iwo Jima", us: 6800, jp: 21000 },
  { name: "冲绳（军人）", en: "Okinawa", us: 12500, jp: 110000 },
];

/* ───────────── 数据：测验 ───────────── */
const QUIZ = [
  { q: "太平洋战争的导火索——珍珠港事件发生在哪一天？",
    opts: ["1941 年 12 月 7 日", "1939 年 9 月 1 日", "1942 年 6 月 4 日", "1945 年 8 月 15 日"],
    a: 0, ex: "1941 年 12 月 7 日清晨，日本偷袭珍珠港，美国次日对日宣战。" },
  { q: "为什么珍珠港偷袭虽重创美军，却埋下日本失败的伏笔？",
    opts: ["日本损失了所有飞机", "美国航母当时不在港内，得以保全", "珍珠港被彻底摧毁", "苏联随即参战"],
    a: 1, ex: "美国的航母（企业号、列克星敦号等）当时出海，未被击中，成为日后反击的核心力量。" },
  { q: "被普遍视为太平洋战争“转折点”的战役是？",
    opts: ["珊瑚海海战", "莱特湾海战", "中途岛海战", "冲绳战役"],
    a: 2, ex: "中途岛海战中美军一日击沉日本四艘主力航母，攻守易势。" },
  { q: "美军在中途岛取得奇袭成功，最关键的因素是？",
    opts: ["数量上的绝对优势", "破译了日军的 JN-25 密码", "天气突变", "日本航母机械故障"],
    a: 1, ex: "美军密码部门破译日军电码，预知作战计划，从而设伏。" },
  { q: "史上规模最大的海战是哪一场？",
    opts: ["中途岛海战", "珊瑚海海战", "莱特湾海战", "马里亚纳海战"],
    a: 2, ex: "1944 年莱特湾海战是历史上规模最大的海战，日本海军主力在此覆灭。" },
  { q: "哪场战役诞生了著名的“折钵山升旗”照片？",
    opts: ["瓜达尔卡纳尔", "硫磺岛", "冲绳", "塞班岛"],
    a: 1, ex: "1945 年硫磺岛战役，海军陆战队在折钵山顶竖起星条旗。" },
  { q: "促使美国下决心使用原子弹的重要因素之一是？",
    opts: ["冲绳战役惨重的伤亡预示进攻本土代价极高", "日本主动求和", "苏联反对登陆", "盟军弹药耗尽"],
    a: 0, ex: "冲绳一役军民死伤逾 20 万，使盟军预估登陆日本本土将付出天文数字的代价。" },
  { q: "日本正式签署投降书是在哪里？",
    opts: ["广岛废墟", "东京皇宫", "停泊东京湾的密苏里号战列舰", "夏威夷珍珠港"],
    a: 2, ex: "1945 年 9 月 2 日，日本代表在东京湾的美国战列舰密苏里号上签署投降书。" },
];

/* ============================================================
   渲染
   ============================================================ */

/* —— 时间轴 —— */
function renderTimeline() {
  const el = document.getElementById("timeline-list");
  el.innerHTML = TIMELINE.map((e, i) => `
    <div class="tl-item" data-side="${e.side}" style="transition-delay:${(i % 6) * 50}ms">
      <div class="tl-date"><b>${e.date.split(" ")[0]}</b>${e.date.includes("–") || e.date.includes("/") ? e.date.replace(/^[^ ]+ ?/, "") : ""}</div>
      <div class="tl-node"></div>
      <div class="tl-card">
        <h4>${e.title}<span class="tag ${e.side === "turn" ? "turn" : e.side}">${e.tag}</span></h4>
        <p>${e.text}</p>
      </div>
    </div>`).join("");

  // 进入动画
  const io = new IntersectionObserver((es) => {
    es.forEach(en => { if (en.isIntersecting) { en.target.classList.add("show"); io.unobserve(en.target); } });
  }, { threshold: 0.15 });
  el.querySelectorAll(".tl-item").forEach(n => io.observe(n));

  // 筛选
  document.getElementById("tlControls").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".tl-btn"); if (!btn) return;
    document.querySelectorAll(".tl-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const f = btn.dataset.f;
    el.querySelectorAll(".tl-item").forEach(n => {
      const show = f === "all" || n.dataset.side === f;
      n.classList.toggle("hidden", !show);
    });
  });
}

/* —— 关键战役 —— */
function renderBattles() {
  const el = document.getElementById("battleList");
  el.innerHTML = BATTLES.map((b, i) => `
    <article class="battle reveal">
      <div class="battle-media">
        <span class="idx">${String(i + 1).padStart(2, "0")}</span>
        <img loading="lazy" src="${IMG(b.img)}" alt="${b.zh}">
        <div class="film"></div>
      </div>
      <div class="battle-body">
        <div class="b-date">${b.date}</div>
        <h3>${b.zh}</h3>
        <div class="b-en">${b.en}</div>
        <p>${b.text}</p>
        <div class="battle-stats">
          ${b.stats.map(s => `<div class="bs"><b>${s[0]}</b><span>${s[1]}</span></div>`).join("")}
        </div>
        <div class="b-outcome ${b.oc}">${b.outcome}</div>
      </div>
    </article>`).join("");
}

/* —— 互动地图 —— */
function renderMap() {
  const W = 1000, H = 600;
  const LON0 = 100, LON1 = 250, LAT0 = 56, LAT1 = -22;
  const px = lon => (lon - LON0) / (LON1 - LON0) * W;
  const py = lat => (LAT0 - lat) / (LAT0 - LAT1) * H;

  // 简化陆地（示意）
  const land = `
    <path class="map-coast" d="M0,30 L130,52 C150,120 110,180 138,250 C160,330 120,400 150,470 C160,520 120,560 145,600 L0,600 Z"/>
    <path class="map-coast" d="M205,90 C235,80 255,110 250,150 C245,185 220,200 205,185 C195,205 180,200 188,175 C182,150 192,110 205,90 Z"/>
    <path class="map-coast" d="M70,520 C150,495 260,500 360,520 C365,560 330,600 300,600 L110,600 C85,580 70,550 70,520 Z"/>
    <path class="map-coast" d="M860,40 C940,55 1000,70 1000,70 L1000,420 C950,400 905,360 885,300 C870,230 880,150 860,40 Z"/>
    <path class="map-coast" d="M470,30 C560,20 660,40 720,30 L720,60 C640,72 540,66 470,72 Z" opacity="0.5"/>
  `;
  // 经纬网
  let grat = "";
  for (let lon = 110; lon <= 240; lon += 20) grat += `<line class="map-graticule" x1="${px(lon)}" y1="0" x2="${px(lon)}" y2="${H}"/>`;
  for (let lat = 50; lat >= -20; lat -= 20) grat += `<line class="map-graticule" x1="0" y1="${py(lat)}" x2="${W}" y2="${py(lat)}"/>`;

  const labels = `
    <text class="map-land-label" x="20" y="200">A S I A</text>
    <text class="map-land-label" x="170" y="600" transform="translate(0,-12)">AUSTRALIA</text>
    <text class="map-land-label" x="905" y="120">N. AMERICA</text>
    <text class="map-land-label" x="208" y="135" style="font-size:9px;letter-spacing:.1em">JAPAN</text>
  `;

  const pts = MAP_POINTS.map((p, i) => {
    const x = px(p.lon), y = py(p.lat);
    const anchor = x > W - 160 ? "end" : "start";
    const lx = anchor === "end" ? x - 12 : x + 12;
    return `<g class="map-pt ${p.side}" data-i="${i}" transform="translate(${x},${y})">
        <circle class="ring" r="7"></circle>
        <circle class="hit" r="16"></circle>
        <circle class="core" r="5.5"></circle>
        <text class="map-label" x="${anchor === "end" ? -12 : 12}" y="4" text-anchor="${anchor}">${p.name.split(" ")[0]}</text>
      </g>`;
  }).join("");

  document.getElementById("mapStage").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="太平洋战区地图">
      ${grat}${land}${labels}${pts}
    </svg>`;

  const info = document.getElementById("mapInfo");
  const stage = document.getElementById("mapStage");
  stage.querySelectorAll(".map-pt").forEach(g => {
    g.addEventListener("click", () => {
      stage.querySelectorAll(".map-pt").forEach(n => n.classList.remove("sel"));
      g.classList.add("sel");
      const p = MAP_POINTS[+g.dataset.i];
      const sideName = p.side === "us" ? "盟军胜利" : p.side === "jp" ? "日本胜利" : "战争转折";
      info.innerHTML = `
        <div class="mi-date">${p.date}</div>
        <h3>${p.name.split(" ")[0]}</h3>
        <div style="font-family:var(--display);font-style:italic;color:rgba(255,255,255,.55);margin-bottom:.3rem">${p.name.split(" ").slice(1).join(" ")}</div>
        <span class="mi-side ${p.side}">${sideName}</span>
        <p>${p.info}</p>
        <div class="map-legend">
          <span class="k"><i style="background:#6db4e6"></i>盟军胜</span>
          <span class="k"><i style="background:#e8745f"></i>日本胜</span>
          <span class="k"><i style="background:#f0c14b"></i>转折点</span>
        </div>`;
    });
  });
}

/* —— 中途岛分步推演 —— */
function ship(id, x, y, label, cls) {
  return `<g class="mw-ship" id="${id}" transform="translate(${x},${y})">
      <rect class="hull" x="-22" y="-7" width="44" height="14" rx="3" fill="#cdd8e0" stroke="#7d8c98"/>
      <line x1="-18" y1="0" x2="18" y2="0" stroke="#5b6b78" stroke-width="1.2"/>
      <g class="burn" opacity="0">
        <circle cx="0" cy="-2" r="9" fill="#e8745f" opacity="0.9"/>
        <circle cx="6" cy="-6" r="5" fill="#f0c14b" opacity="0.9"/>
        <circle cx="-7" cy="-5" r="4" fill="#b23222"/>
      </g>
      <text x="0" y="20" text-anchor="middle" fill="rgba(255,255,255,.78)" font-size="10" font-family="var(--sans)">${label}</text>
    </g>`;
}
function renderMidway() {
  const stage = document.getElementById("mwStage");
  // 日本机动部队（中上）
  const jp = ship("jp1", 380, 110, "赤城") + ship("jp2", 470, 95, "加贺")
           + ship("jp3", 420, 175, "苍龙") + ship("jp4", 540, 165, "飞龙");
  // 美军航母（右）
  const us = `<g id="usFleet" opacity="0.12">
      ${ship("us1", 800, 200, "企业")}${ship("us2", 820, 280, "大黄蜂")}${ship("us3", 760, 355, "约克城")}
      <text id="usQ" x="790" y="160" text-anchor="middle" fill="#f0c14b" font-size="34" font-family="var(--display)">?</text>
    </g>`;
  const midway = `<g transform="translate(120,300)">
      <circle r="26" fill="none" stroke="#6db4e6" stroke-width="1.5" stroke-dasharray="3 4"/>
      <circle r="9" fill="#16344b" stroke="#6db4e6"/>
      <text y="46" text-anchor="middle" fill="rgba(255,255,255,.8)" font-size="11" font-family="var(--sans)">中途岛</text>
    </g>`;
  const jpStrike = `<g id="jpStrike" class="mw-strike">
      <path d="M 430 150 Q 280 230 160 295" fill="none" stroke="#e8745f" stroke-width="2" stroke-dasharray="5 6" marker-end="url(#ah-r)"/>
    </g>`;
  const usStrike = `<g id="usStrike" class="mw-strike">
      <path d="M 770 250 Q 620 180 500 140" fill="none" stroke="#6db4e6" stroke-width="2" stroke-dasharray="5 6" marker-end="url(#ah-b)"/>
      <path d="M 770 250 Q 600 220 460 150" fill="none" stroke="#6db4e6" stroke-width="2" stroke-dasharray="5 6"/>
    </g>`;
  const hiryuStrike = `<g id="hiryuStrike" class="mw-strike">
      <path d="M 540 165 Q 660 250 760 350" fill="none" stroke="#e8745f" stroke-width="2" stroke-dasharray="5 6" marker-end="url(#ah-r)"/>
    </g>`;
  const warn = `<g id="mwWarn" opacity="0"><text x="460" y="55" text-anchor="middle" fill="#f0c14b" font-size="12" font-family="var(--sans)">⚠ 甲板堆满弹药与燃油</text></g>`;

  stage.innerHTML = `
    <svg viewBox="0 0 940 460" role="img" aria-label="中途岛海战推演">
      <defs>
        <marker id="ah-r" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#e8745f"/></marker>
        <marker id="ah-b" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#6db4e6"/></marker>
      </defs>
      <text x="470" y="34" text-anchor="middle" fill="rgba(255,255,255,.35)" font-size="12" font-family="var(--mono)" letter-spacing="3">BATTLE OF MIDWAY · 1942.06.04</text>
      ${midway}${jpStrike}${usStrike}${hiryuStrike}
      <text x="460" y="74" text-anchor="middle" fill="rgba(232,116,95,.7)" font-size="11" font-family="var(--sans)">日本机动部队（南云）</text>
      ${jp}${warn}${us}
    </svg>`;

  const STEPS = [
    { t: "拂晓：机动部队逼近", d: "1942 年 6 月 4 日清晨，南云忠一指挥的四艘主力航母——赤城、加贺、苍龙、飞龙——逼近中途岛，准备以舰载机摧毁岛上的美军设施，再夺取该岛。" },
    { t: "第一波空袭中途岛", d: "日军派出第一波飞机轰炸中途岛。打击效果不彻底，前线指挥官请求发动第二波攻击——这意味着甲板上的飞机需要从对舰鱼雷改挂对地炸弹。", on: ["jpStrike"] },
    { t: "美军伏击：航母现身", d: "南云并不知道：尼米兹凭借破译的密码情报，早已让企业号、大黄蜂号、约克城号埋伏在侧翼。日军侦察迟缓，发现美军航母时为时已晚。", show: ["usFleet"] },
    { t: "致命的换弹时刻", d: "侦察到美军舰队后，南云下令把刚换好的对地炸弹再换回鱼雷。于是在最危险的时刻，四艘航母的甲板与机库里堆满了油料和弹药——一点火星即可酿成灾难。", warn: true, show: ["usFleet"] },
    { t: "改变战争的五分钟", d: "美军 SBD 无畏式俯冲轰炸机几乎未受拦截，自高空俯冲而下。短短几分钟内，赤城、加贺、苍龙相继中弹，甲板上的弹药接连殉爆，三艘航母化作火海。", show: ["usFleet"], strike: ["usStrike"], burn: ["jp1", "jp2", "jp3"] },
    { t: "飞龙的反击与覆灭", d: "幸存的飞龙发动反击，重创美军约克城号（后被潜艇击沉）。但当天下午飞龙也被美军击中焚毁。一日之间，日本失去四艘主力航母与大批精锐飞行员——再也无法弥补。", show: ["usFleet"], strike: ["hiryuStrike"], burn: ["jp1", "jp2", "jp3", "jp4", "us3"] },
  ];

  let step = 0;
  const numEl = document.getElementById("mwStepNum");
  const titleEl = document.getElementById("mwTitle");
  const descEl = document.getElementById("mwDesc");
  const prevB = document.getElementById("mwPrev");
  const nextB = document.getElementById("mwNext");
  const prog = document.getElementById("mwProgress");
  prog.innerHTML = STEPS.map(() => "<i></i>").join("");

  function apply(n) {
    const s = STEPS[n];
    numEl.textContent = `第 ${n + 1} / ${STEPS.length} 步`;
    titleEl.textContent = s.t;
    descEl.textContent = s.d;
    // 重置
    ["jpStrike", "usStrike", "hiryuStrike"].forEach(id => document.getElementById(id).style.opacity = (s.strike && s.strike.includes(id)) || (s.on && s.on.includes(id)) ? 1 : 0);
    document.getElementById("mwWarn").setAttribute("opacity", s.warn ? 1 : 0);
    const usf = document.getElementById("usFleet");
    usf.setAttribute("opacity", (s.show && s.show.includes("usFleet")) ? 1 : 0.12);
    document.getElementById("usQ").setAttribute("opacity", (s.show && s.show.includes("usFleet")) ? 0 : 1);
    ["jp1", "jp2", "jp3", "jp4", "us1", "us2", "us3"].forEach(id => {
      const burning = s.burn && s.burn.includes(id);
      const g = document.querySelector(`#${id} .burn`);
      if (g) g.setAttribute("opacity", burning ? 1 : 0);
    });
    prog.querySelectorAll("i").forEach((b, bi) => b.classList.toggle("on", bi <= n));
    prevB.disabled = n === 0;
    nextB.disabled = n === STEPS.length - 1;
  }
  prevB.addEventListener("click", () => { if (step > 0) apply(--step); });
  nextB.addEventListener("click", () => { if (step < STEPS.length - 1) apply(++step); });
  apply(0);
}

/* —— 兵力对比 —— */
function renderCompare() {
  const el = document.getElementById("compareGrid");
  const col = (key) => {
    const c = FORCES[key];
    return `<div class="cmp-col ${key}">
      <h3><i></i>${c.title}</h3>
      <div class="cmp-en">${c.en}</div>
      ${c.rows.map(r => `
        <div class="cmp-row">
          <div class="cr-label"><span>${r.label}</span><b>${r.val}</b></div>
          <div class="cmp-bar"><i data-pct="${r.pct}"></i></div>
        </div>`).join("")}
      <p class="cmp-note">${c.note}</p>
    </div>`;
  };
  el.innerHTML = col("us") + col("jp");
}

/* —— 伤亡 —— */
function renderCost() {
  const el = document.getElementById("costGrid");
  const max = Math.max(...CASUALTIES.flatMap(c => [c.us, c.jp]));
  const fmt = n => n.toLocaleString("en-US");
  el.innerHTML = CASUALTIES.map(c => `
    <div class="cost-row">
      <div class="cr-name">${c.name}<small>${c.en}</small></div>
      <div class="cost-bars">
        <div class="cost-bar us"><span class="who">美</span><div class="track"><i data-w="${(c.us / max * 100).toFixed(1)}"></i></div><span class="val">${fmt(c.us)}</span></div>
        <div class="cost-bar jp"><span class="who">日</span><div class="track"><i data-w="${(c.jp / max * 100).toFixed(1)}"></i></div><span class="val">${fmt(c.jp)}</span></div>
      </div>
    </div>`).join("");
}

/* —— 测验 —— */
function renderQuiz() {
  const card = document.getElementById("quizCard");
  let idx = 0, score = 0, answered = false;

  function show() {
    const q = QUIZ[idx];
    answered = false;
    card.innerHTML = `
      <div class="quiz-meta"><span>问题 ${idx + 1} / ${QUIZ.length}</span><span class="quiz-score">得分 ${score}</span></div>
      <div class="quiz-q">${q.q}</div>
      <div class="quiz-opts">
        ${q.opts.map((o, i) => `<button class="quiz-opt" data-i="${i}"><span class="mk">${String.fromCharCode(65 + i)}</span>${o}</button>`).join("")}
      </div>
      <div class="quiz-explain" id="qx">${q.ex}</div>
      <div class="quiz-foot">
        <span class="quiz-score">${idx === QUIZ.length - 1 ? "最后一题" : ""}</span>
        <button class="quiz-next" id="qnext" disabled>${idx === QUIZ.length - 1 ? "查看结果" : "下一题 →"}</button>
      </div>`;
    card.querySelectorAll(".quiz-opt").forEach(b => b.addEventListener("click", () => choose(b, q)));
    document.getElementById("qnext").addEventListener("click", () => {
      if (idx === QUIZ.length - 1) result(); else { idx++; show(); }
    });
  }
  function choose(btn, q) {
    if (answered) return;
    answered = true;
    const pick = +btn.dataset.i;
    if (pick === q.a) { btn.classList.add("correct"); score++; }
    else { btn.classList.add("wrong"); card.querySelector(`.quiz-opt[data-i="${q.a}"]`).classList.add("correct"); }
    card.querySelectorAll(".quiz-opt").forEach(b => b.disabled = true);
    document.getElementById("qx").classList.add("show");
    document.getElementById("qnext").disabled = false;
    card.querySelector(".quiz-score").textContent = `得分 ${score}`;
  }
  function result() {
    const pct = Math.round(score / QUIZ.length * 100);
    const verdict = pct === 100 ? "太平洋战争专家！" : pct >= 75 ? "功底扎实。" : pct >= 50 ? "不错，再接再厉。" : "回到上面再读一遍吧。";
    card.innerHTML = `
      <div class="quiz-result">
        <div class="big">${score}<span style="font-size:1.6rem;color:var(--ink-faint)"> / ${QUIZ.length}</span></div>
        <p>${verdict}　正确率 ${pct}%</p>
        <button class="quiz-next" id="qretry">重新测验</button>
      </div>`;
    document.getElementById("qretry").addEventListener("click", () => { idx = 0; score = 0; show(); });
  }
  show();
}

/* —— 滚动揭示 + 条形动画 —— */
function setupReveal() {
  const io = new IntersectionObserver((es) => {
    es.forEach(en => {
      if (!en.isIntersecting) return;
      en.target.classList.add("in");
      // 触发条形动画
      en.target.querySelectorAll(".cmp-bar i").forEach(b => b.style.width = b.dataset.pct + "%");
      en.target.querySelectorAll(".cost-bar i").forEach(b => b.style.width = b.dataset.w + "%");
      io.unobserve(en.target);
    });
  }, { threshold: 0.12 });
  document.querySelectorAll(".reveal").forEach(n => io.observe(n));
}

/* —— 导航 —— */
function setupNav() {
  const links = document.querySelector(".nav-links");
  document.querySelector(".nav-toggle").addEventListener("click", () => links.classList.toggle("open"));
  links.addEventListener("click", e => { if (e.target.tagName === "A") links.classList.remove("open"); });
}

/* —— 启动 —— */
document.addEventListener("DOMContentLoaded", () => {
  renderTimeline();
  renderBattles();
  renderMap();
  renderMidway();
  renderCompare();
  renderCost();
  renderQuiz();
  setupNav();
  setupReveal();
});
