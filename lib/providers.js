// 内置提供商模板：只记录"地址 + 协议 + 关闭思考的参数"，不内置模型名
// （模型名会随版本上下线，一律从接口拉取）。
// 用户选中模板只是自动填写，所有字段仍然可以手动改。
//
// thinkingOff：选「思考模式 → 尽量关闭」时合并进请求体的片段。
// 各家参数名不统一，来源见 CHANGELOG 与 docs/ROADMAP.md。
export const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    engine: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    // 官方：思考模式默认开启，用 thinking.type 关闭；reasoning_effort 只调强度
    thinkingOff: { thinking: { type: 'disabled' } }
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    engine: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    // GLM-5.3 / 5.3-FLASH 强制思考，传了也会被拒绝（上层会自动降级重试）
    thinkingOff: { thinking: { type: 'disabled' } }
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    engine: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    // kimi-k2.6 可关；k3 始终思考、k2.7-code 传 disabled 会报错（上层会降级）
    thinkingOff: { thinking: { type: 'disabled' } }
  },
  {
    id: 'dashscope',
    name: '阿里云百炼（千问）',
    engine: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/',
    thinkingOff: { enable_thinking: false }
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    engine: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    // 聚合平台以千问系为主；其它模型不认识这个参数时会被上层降级
    thinkingOff: { enable_thinking: false }
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    engine: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    // OpenRouter 的统一参数；mandatory 模型会拒绝（上层降级）
    thinkingOff: { reasoning: { enabled: false } }
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    engine: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    keyUrl: '',
    thinkingOff: null
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    engine: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    keyUrl: '',
    thinkingOff: null
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    engine: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    // 新版 Claude 默认可能是自适应思考；旧模型不认这个值会被降级
    thinkingOff: { thinking: { type: 'disabled' } }
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    engine: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    // Gemini 的关闭参数随代际不同（2.5 用 thinkingBudget、3 用 thinkingLevel），
    // 由引擎按模型名决定，模板不硬编码
    thinkingOff: null
  }
];

// 下拉里固定置底的"自定义"哨兵值
export const CUSTOM_PROVIDER_ID = '__custom__';

function normalize(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
}

// 根据当前地址反查是哪个模板（用于打开设置页时自动选中）
export function findProviderByBaseUrl(baseUrl) {
  const target = normalize(baseUrl);
  if (!target) return null;
  return PROVIDERS.find((p) => normalize(p.baseUrl) === target) || null;
}

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}
