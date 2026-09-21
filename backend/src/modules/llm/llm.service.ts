import { db } from '../../db';
import { appSettings, customAiGateways, CustomAiGateway, NewCustomAiGateway } from '../../db/schema';
import { eq, inArray, desc } from 'drizzle-orm';
import { geminiProvider } from './providers/gemini.provider';
import {
  customProvider,
  createCustomGatewayProvider,
  createOpenAICompatibleProvider,
} from './providers/openaiCompatible.provider';
import { recordTokenUsage } from '../tokenUsage/tokenUsage.service';
import {
  AllProvidersExhaustedError,
  BuiltinChatProviderId,
  BUILTIN_CHAT_PROVIDER_IDS,
  ChatProvider,
  ChatProviderId,
  FALLBACK_ORDER,
  ProviderQuotaError,
} from './llm.types';

/**
 * Điều phối provider cho AI Chat: đọc cấu hình Admin từ app_settings, gọi provider chính,
 * và tự động chuyển sang provider khác còn quota khi provider chính lỗi.
 */

export const CHAT_PROVIDER_KEY = 'chat_provider';
export const CHAT_MODEL_KEY = 'chat_model';

/** Provider mặc định khi Admin chưa từng cấu hình — giữ nguyên hành vi cũ của hệ thống. */
const DEFAULT_CHAT_PROVIDER: ChatProviderId = 'gemini';

const BUILTIN_PROVIDERS: Record<BuiltinChatProviderId, ChatProvider> = {
  custom: customProvider,
  gemini: geminiProvider,
};

export async function getProvider(id: ChatProviderId): Promise<ChatProvider | undefined> {
  if (id in BUILTIN_PROVIDERS) {
    return BUILTIN_PROVIDERS[id as BuiltinChatProviderId];
  }

  if (id.startsWith('custom_')) {
    const gatewayId = id.replace('custom_', '');
    try {
      const [gateway] = await db
        .select()
        .from(customAiGateways)
        .where(eq(customAiGateways.id, gatewayId));
      if (gateway && gateway.isActive) {
        return createCustomGatewayProvider(gateway);
      }
    } catch (err) {
      console.error(`[LLM] Lỗi tìm custom gateway ${id}:`, err);
    }
  }

  return undefined;
}

export function isBuiltinChatProviderId(value: string): value is BuiltinChatProviderId {
  return (BUILTIN_CHAT_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isChatProviderId(value: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  return isBuiltinChatProviderId(value) || value.startsWith('custom_');
}

// ─── Cấu hình (app_settings + cache) ─────────────────────────────────────────

interface ChatConfig {
  providerId: ChatProviderId;
  model: string;
}

/**
 * Cache cấu hình 60s để mỗi câu hỏi không phải query app_settings 2 lần.
 * Admin đổi cấu hình xong thì admin.router gọi invalidateChatConfigCache() để có hiệu lực ngay.
 */
let cachedConfig: { value: ChatConfig; expiresAt: number } | null = null;
const CONFIG_CACHE_MS = 60_000;

export function invalidateChatConfigCache(): void {
  cachedConfig = null;
}

export async function getChatConfig(): Promise<ChatConfig> {
  if (cachedConfig && cachedConfig.expiresAt > Date.now()) return cachedConfig.value;

  let providerId: ChatProviderId = DEFAULT_CHAT_PROVIDER;
  let model = '';

  try {
    const rows = await db
      .select()
      .from(appSettings)
      .where(inArray(appSettings.key, [CHAT_PROVIDER_KEY, CHAT_MODEL_KEY]));

    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const storedProvider = stored[CHAT_PROVIDER_KEY];
    if (storedProvider && isChatProviderId(storedProvider)) {
      providerId = storedProvider;
    }
    model = stored[CHAT_MODEL_KEY] ?? '';
  } catch (err) {
    // DB lỗi thì vẫn phải trả lời được — dùng mặc định thay vì để cả AI Chat chết theo
    console.error('[LLM] Không đọc được cấu hình provider, dùng mặc định:', err);
  }

  const activeProvider = (await getProvider(providerId)) ?? BUILTIN_PROVIDERS.gemini;
  const value: ChatConfig = { providerId, model: model || activeProvider.defaultModel };
  cachedConfig = { value, expiresAt: Date.now() + CONFIG_CACHE_MS };
  return value;
}

export async function saveChatConfig(providerId: ChatProviderId, model: string): Promise<void> {
  const now = new Date();
  const rows = [
    { key: CHAT_PROVIDER_KEY, value: providerId },
    { key: CHAT_MODEL_KEY, value: model },
  ];

  for (const row of rows) {
    await db
      .insert(appSettings)
      .values({ ...row, updatedAt: now })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: row.value, updatedAt: now },
      });
  }

  invalidateChatConfigCache();
}

// ─── Gọi model + fallback ────────────────────────────────────────────────────

export interface ChatCallOptions {
  systemPrompt: string;
  userMessage: string;
  temperature: number;
  maxOutputTokens: number;
}

/**
 * Gọi model chat với chuỗi fallback:
 * 1. Provider Admin đang chọn (kèm model Admin đã chọn).
 * 2. Nếu lỗi → thử lần lượt theo FALLBACK_ORDER, bỏ qua provider đã thử và provider chưa có API key,
 *    mỗi provider dự phòng dùng model mặc định của chính nó.
 * 3. Tất cả đều thất bại → ném AllProvidersExhaustedError để FE cảnh báo Admin.
 */
export async function callChatModel(options: ChatCallOptions): Promise<string> {
  const config = await getChatConfig();
  const primaryProvider = (await getProvider(config.providerId)) ?? BUILTIN_PROVIDERS.gemini;

  // Provider chính đứng đầu hàng đợi, phần còn lại theo thứ tự fallback đã thống nhất
  const queue: Array<{ provider: ChatProvider; model: string }> = [
    { provider: primaryProvider, model: config.model },
    ...FALLBACK_ORDER.filter((id) => id !== config.providerId).map((id) => ({
      provider: BUILTIN_PROVIDERS[id as BuiltinChatProviderId],
      model: BUILTIN_PROVIDERS[id as BuiltinChatProviderId].defaultModel,
    })),
  ];

  const attempts: Array<{ providerId: ChatProviderId; reason: string }> = [];

  for (const { provider, model } of queue) {
    if (!provider || !provider.hasApiKey()) {
      const keyHint = provider?.apiKeyEnvName ? `chưa cấu hình ${provider.apiKeyEnvName}` : 'chưa có API Key';
      attempts.push({ providerId: provider?.id ?? 'unknown', reason: keyHint });
      continue;
    }

    try {
      const result = await provider.generate({
        systemPrompt: options.systemPrompt,
        userMessage: options.userMessage,
        model,
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens,
      });

      // Ghi thống kê token ở ĐÂY chứ không ở ai.service: chỉ chỗ này mới biết provider/model nào
      // thực sự trả lời (có thể là provider dự phòng, khác với cấu hình Admin chọn).
      // Fire-and-forget — recordTokenUsage tự nuốt lỗi, thống kê không bao giờ chặn câu trả lời.
      if (result.usage) void recordTokenUsage(provider.id, model, result.usage);

      // Đã phải fallback — ghi log để Admin biết provider chính đang có vấn đề
      if (provider.id !== config.providerId) {
        console.warn(
          `[LLM] Provider chính (${config.providerId}) không dùng được, đã trả lời bằng ${provider.id}/${model}`,
        );
      }

      return result.text;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      attempts.push({ providerId: provider.id, reason });

      const kind = err instanceof ProviderQuotaError ? 'hết quota' : 'lỗi';
      console.warn(`[LLM] ${provider.id} (${model}) ${kind}: ${reason}`);
    }
  }

  // Không provider nào trả lời được
  console.error(
    '[LLM] Tất cả provider đều thất bại:',
    attempts.map((a) => `${a.providerId}: ${a.reason}`).join(' | '),
  );
  throw new AllProvidersExhaustedError(attempts);
}

// ─── Phục vụ màn hình cấu hình của Admin ─────────────────────────────────────

export interface ProviderStatus {
  id: ChatProviderId;
  label: string;
  defaultModel: string;
  suggestedModels: string[];
  apiKeyEnvName?: string;
  isCustom?: boolean;
  customGatewayId?: string;
  /** Chỉ báo đã có key hay chưa — KHÔNG bao giờ trả giá trị key về frontend. */
  hasApiKey: boolean;
}

export async function getChatProviderSettings(): Promise<{
  providerId: ChatProviderId;
  model: string;
  fallbackOrder: ChatProviderId[];
  providers: ProviderStatus[];
}> {
  const config = await getChatConfig();

  // 1. Builtin providers
  const builtinStatuses: ProviderStatus[] = BUILTIN_CHAT_PROVIDER_IDS.map((id) => {
    const p = BUILTIN_PROVIDERS[id];
    return {
      id: p.id,
      label: p.label,
      defaultModel: p.defaultModel,
      suggestedModels: p.suggestedModels,
      apiKeyEnvName: p.apiKeyEnvName,
      isCustom: false,
      hasApiKey: p.hasApiKey(),
    };
  });

  // 2. Custom gateways from DB
  let customStatuses: ProviderStatus[] = [];
  try {
    const gateways = await db
      .select()
      .from(customAiGateways)
      .where(eq(customAiGateways.isActive, true))
      .orderBy(desc(customAiGateways.createdAt));

    customStatuses = gateways.map((g) => ({
      id: `custom_${g.id}`,
      label: `${g.name} (Custom)`,
      defaultModel: g.defaultModel,
      suggestedModels: g.suggestedModels && g.suggestedModels.length > 0 ? g.suggestedModels : [g.defaultModel],
      isCustom: true,
      customGatewayId: g.id,
      hasApiKey: !!g.apiKey,
    }));
  } catch (err) {
    console.error('[LLM] Không thể tải custom gateways từ DB:', err);
  }

  return {
    providerId: config.providerId,
    model: config.model,
    fallbackOrder: FALLBACK_ORDER,
    providers: [...builtinStatuses, ...customStatuses],
  };
}

/**
 * Gọi thử provider bằng một câu hỏi rất ngắn để Admin xác nhận key/model dùng được
 * TRƯỚC khi lưu cấu hình. Không fallback — mục đích là kiểm tra đúng provider được chỉ định.
 */
export async function testChatProvider(
  providerId: ChatProviderId,
  model?: string,
): Promise<{ ok: true; model: string; sample: string }> {
  const provider = await getProvider(providerId);
  if (!provider) {
    throw new Error(`Không tìm thấy provider '${providerId}'`);
  }

  const targetModel = model?.trim() || provider.defaultModel;

  if (!provider.hasApiKey()) {
    const msg = provider.apiKeyEnvName
      ? `Chưa cấu hình ${provider.apiKeyEnvName} trong file .env ở thư mục gốc`
      : 'Cổng này chưa có API Key';
    throw new Error(msg);
  }

  const result = await provider.generate({
    systemPrompt: 'Bạn là trợ lý kiểm tra kết nối. Trả lời đúng một từ.',
    userMessage: 'Trả lời đúng một từ: OK',
    model: targetModel,
    temperature: 0,
    maxOutputTokens: 32,
  });

  // Lần bấm "Kiểm tra kết nối" cũng tiêu quota thật của API key nên vẫn được tính vào thống kê
  if (result.usage) void recordTokenUsage(provider.id, targetModel, result.usage);

  return { ok: true, model: targetModel, sample: result.text.trim().slice(0, 100) };
}

/**
 * Lấy danh sách model mà key hiện tại của provider được phép dùng.
 */
export async function fetchProviderModels(
  providerId: ChatProviderId,
): Promise<{ supported: boolean; models: string[] }> {
  const provider = await getProvider(providerId);
  if (!provider) {
    throw new Error(`Không tìm thấy provider '${providerId}'`);
  }

  if (!provider.hasApiKey()) {
    const msg = provider.apiKeyEnvName
      ? `Chưa cấu hình ${provider.apiKeyEnvName} trong file .env ở thư mục gốc`
      : 'Cổng này chưa có API Key';
    throw new Error(msg);
  }
  if (!provider.listModels) {
    return { supported: false, models: [] };
  }

  const models = await provider.listModels();
  return { supported: true, models };
}

/** Xoá cấu hình provider khỏi app_settings — đưa hệ thống về provider mặc định (Gemini). */
export async function resetChatConfig(): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, CHAT_PROVIDER_KEY));
  await db.delete(appSettings).where(eq(appSettings.key, CHAT_MODEL_KEY));
  invalidateChatConfigCache();
}

// ─── CRUD Quản lý Custom AI Gateways từ DB ─────────────────────────────────────

export interface CustomGatewayPublicItem {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  defaultModel: string;
  suggestedModels: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '********';
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

export async function listCustomGateways(): Promise<CustomGatewayPublicItem[]> {
  const list = await db.select().from(customAiGateways).orderBy(desc(customAiGateways.createdAt));
  return list.map((g) => ({
    id: g.id,
    name: g.name,
    baseUrl: g.baseUrl,
    apiKeyMasked: maskApiKey(g.apiKey),
    defaultModel: g.defaultModel,
    suggestedModels: g.suggestedModels ?? [],
    isActive: g.isActive,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  }));
}

export async function createCustomGateway(data: {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  suggestedModels?: string[];
  isActive?: boolean;
}): Promise<CustomGatewayPublicItem> {
  const [created] = await db
    .insert(customAiGateways)
    .values({
      name: data.name.trim(),
      baseUrl: data.baseUrl.trim(),
      apiKey: data.apiKey.trim(),
      defaultModel: data.defaultModel.trim(),
      suggestedModels: data.suggestedModels ?? [data.defaultModel.trim()],
      isActive: data.isActive ?? true,
    })
    .returning();

  invalidateChatConfigCache();

  return {
    id: created.id,
    name: created.name,
    baseUrl: created.baseUrl,
    apiKeyMasked: maskApiKey(created.apiKey),
    defaultModel: created.defaultModel,
    suggestedModels: created.suggestedModels ?? [],
    isActive: created.isActive,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  };
}

export async function updateCustomGateway(
  id: string,
  data: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    defaultModel?: string;
    suggestedModels?: string[];
    isActive?: boolean;
  },
): Promise<CustomGatewayPublicItem> {
  const [existing] = await db.select().from(customAiGateways).where(eq(customAiGateways.id, id));
  if (!existing) {
    throw new Error('Không tìm thấy cổng AI custom');
  }

  const updateValues: Partial<NewCustomAiGateway> = {
    updatedAt: new Date(),
  };

  if (data.name !== undefined) updateValues.name = data.name.trim();
  if (data.baseUrl !== undefined) updateValues.baseUrl = data.baseUrl.trim();
  if (data.apiKey !== undefined && data.apiKey.trim() !== '') {
    updateValues.apiKey = data.apiKey.trim();
  }
  if (data.defaultModel !== undefined) updateValues.defaultModel = data.defaultModel.trim();
  if (data.suggestedModels !== undefined) updateValues.suggestedModels = data.suggestedModels;
  if (data.isActive !== undefined) updateValues.isActive = data.isActive;

  const [updated] = await db
    .update(customAiGateways)
    .set(updateValues)
    .where(eq(customAiGateways.id, id))
    .returning();

  invalidateChatConfigCache();

  return {
    id: updated.id,
    name: updated.name,
    baseUrl: updated.baseUrl,
    apiKeyMasked: maskApiKey(updated.apiKey),
    defaultModel: updated.defaultModel,
    suggestedModels: updated.suggestedModels ?? [],
    isActive: updated.isActive,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
}

export async function deleteCustomGateway(id: string): Promise<void> {
  const [existing] = await db.select().from(customAiGateways).where(eq(customAiGateways.id, id));
  if (!existing) {
    throw new Error('Không tìm thấy cổng AI custom');
  }

  await db.delete(customAiGateways).where(eq(customAiGateways.id, id));

  // Nếu đang được chọn làm active chat provider thì chuyển về gemini
  const currentConfig = await getChatConfig();
  if (currentConfig.providerId === `custom_${id}`) {
    await saveChatConfig(DEFAULT_CHAT_PROVIDER, BUILTIN_PROVIDERS.gemini.defaultModel);
  }

  invalidateChatConfigCache();
}

/**
 * Test trực tiếp một kết nối custom gateway (dùng khi Admin nhập form trước khi bấm Lưu)
 */
export async function testDirectGateway(data: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<{ ok: true; model: string; sample: string }> {
  const tempProvider = createOpenAICompatibleProvider({
    id: 'custom_test_temp',
    label: 'Test Gateway',
    baseUrl: data.baseUrl.trim(),
    getApiKey: () => data.apiKey.trim(),
    defaultModel: data.model.trim(),
    suggestedModels: [data.model.trim()],
    requestTimeoutMs: 30_000,
  });

  const result = await tempProvider.generate({
    systemPrompt: 'Bạn là trợ lý kiểm tra kết nối. Trả lời đúng một từ.',
    userMessage: 'Trả lời đúng một từ: OK',
    model: data.model.trim(),
    temperature: 0,
    maxOutputTokens: 32,
  });

  return { ok: true, model: data.model.trim(), sample: result.text.trim().slice(0, 100) };
}

/**
 * Tải danh sách model trực tiếp từ baseUrl + apiKey
 */
export async function listDirectGatewayModels(data: {
  baseUrl: string;
  apiKey: string;
}): Promise<{ supported: boolean; models: string[] }> {
  const tempProvider = createOpenAICompatibleProvider({
    id: 'custom_test_temp',
    label: 'Test Gateway',
    baseUrl: data.baseUrl.trim(),
    getApiKey: () => data.apiKey.trim(),
    defaultModel: 'default',
    suggestedModels: [],
    requestTimeoutMs: 30_000,
  });

  if (!tempProvider.listModels) {
    return { supported: false, models: [] };
  }

  const models = await tempProvider.listModels();
  return { supported: true, models };
}
