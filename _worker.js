/**
 * 耆守 SilverGuard · 云端 AI 研判代理（Cloudflare Worker）
 *
 * 作用：前端只调用这个 Worker，DeepSeek API Key 存在 Worker 的环境变量里，前端拿不到。
 *
 * 部署步骤：
 * 1. Cloudflare 后台 → Workers & Pages → Create Worker
 * 2. 把本文件全部内容粘贴进编辑器，Deploy
 * 3. Settings → Variables and Secrets → 新增 Secret：
 *      名称：DEEPSEEK_API_KEY
 *      值：你的 DeepSeek Key（sk-...）
 * 4. 复制你的 Worker 地址（https://xxx.workers.dev），填到 Demo 的 AI_ENDPOINT
 */

// 六类话术库的检索关键词（简易 RAG 的"检索"部分）
const KB = {
  "冒充亲友（含AI换脸/拟声）": [
    "孙子", "孙女", "儿子", "女儿", "外孙", "亲戚", "借钱", "急用", "私了", "撞人",
    "住院", "手术", "别告诉", "保密", "视频", "声音", "换脸", "拟声", "同学手机",
    "代付", "转钱", "学费", "医药费"
  ],
  "冒充公检法": [
    "公安", "警察", "民警", "检察院", "法院", "涉案", "洗钱", "通缉", "安全账户",
    "验资", "冻结", "医保", "社保", "拘留", "逮捕", "配合调查", "别挂电话", "配合",
    "证件", "传票"
  ],
  "冒充客服退款": [
    "客服", "退款", "理赔", "快递", "订单", "验证码", "保证金", "屏幕共享",
    "下载APP", "三倍", "退货", "商品", "质量问题", "激活"
  ],
  "虚假中奖": [
    "中奖", "幸运", "大奖", "公证费", "税费", "领奖", "过期", "抽奖", "红包",
    "兑奖", "中签", "名额"
  ],
  "投资理财·杀猪盘": [
    "导师", "带你", "稳赚", "虚拟币", "比特币", "投资", "理财", "内幕", "老师",
    "加群", "试水", "高回报", "翻倍", "平台", "提现"
  ],
  "保健品·养老诈骗": [
    "保健品", "神药", "体检", "讲座", "专家", "包治", "疗效", "养老", "会员",
    "定金", "免费领", "养生", "偏方", "试用"
  ]
};

function retrieve(text) {
  const scored = Object.entries(KB).map(([type, kws]) => {
    const hits = kws.filter(k => text.includes(k));
    return { type, hits, score: hits.length };
  }).sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score > 0).slice(0, 2);
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors }
  });
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, cors);

    let text = "";
    try {
      const body = await request.json();
      text = String(body.text || "").slice(0, 600);
    } catch (e) {}
    if (!text.trim()) return json({ error: "empty text" }, 400, cors);

    // ---- 简易 RAG：先检索最相关的 1–2 类话术特征 ----
    const refs = retrieve(text);
    const refText = refs.length
      ? refs.map(r => `【${r.type}】命中词：${r.hits.join("、")}`).join("\n")
      : "（未检索到明显命中词）";

    const sys = `你是「转账前最后一分钟」反诈核实助手的云端研判模块。用户（多为老年人）正在描述接到的一通可疑电话或信息。
请依据描述和参考特征，判断它属于哪一类诈骗（或"无"）。

可选类型（只能从这六类里选，或选"无"）：
1. 冒充亲友（含AI换脸/拟声）
2. 冒充公检法
3. 冒充客服退款
4. 虚假中奖
5. 投资理财·杀猪盘
6. 保健品·养老诈骗

参考特征（检索结果，仅供参考，可能不全）：
${refText}

要求：
- 只依据用户描述和参考特征判断，不要编造事实；
- 理由必须用大白话，面向老人，每条不超过 25 字；
- 证据不足时 type 填"无"、confidence 填"低"；
- 只输出 JSON，不要任何解释性文字、不要 markdown 代码块。

输出格式：
{"type":"类型名或\\"无\\"","confidence":"高/中/低","reasons":["理由1","理由2","理由3"],"advice":"一句劝阻建议，不超过 30 字"}`;

    try {
      const r = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + env.DEEPSEEK_API_KEY
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "system", content: sys },
            { role: "user", content: text }
          ],
          temperature: 0.2,
          max_tokens: 500
        })
      });

      const d = await r.json();
      const content = (d && d.choices && d.choices[0] && d.choices[0].message)
        ? d.choices[0].message.content : "";

      let parsed = null;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
      }

      if (!parsed) return json({ error: "parse failed", raw: content.slice(0, 200) }, 502, cors);

      return json({
        type: parsed.type || "无",
        confidence: parsed.confidence || "中",
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 4) : [],
        advice: parsed.advice || "",
        _refs: refs.map(r => ({ type: r.type, hits: r.hits }))
      }, 200, cors);

    } catch (e) {
      return json({ error: "upstream failed", message: String(e) }, 502, cors);
    }
  }
};
