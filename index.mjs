import { createHash, randomUUID } from 'node:crypto';
import { installMembersEndpoint } from './existing-members.mjs';
const activationIds = new WeakMap();

export const name = 'web-model-switch';
export const inject = ['llm', 'configEditor', 'agentDefaultModel'];
export const API_PATH = '/plugins/local-model-switch';

class SwitchFault extends Error {
  constructor(message, status = 400) {super(message); this.status = status;}
}
function fault(message, status = 400) {return new SwitchFault(message, status);}
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function reply(res, status, value) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(JSON.stringify(value));
}
export async function jsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 8192) throw fault('请求过大', 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return value;
  } catch {throw fault('无效的 JSON 对象');}
}
function teamEntry(ctx) {
  return ctx.configEditor.entries().find(entry => entry.options.id === 'agent-teams');
}
function teamInfo(ctx) {
  const entry = teamEntry(ctx);
  if (!entry || entry.fiber?.state !== 2) return {available: false, hot: false};
  const schema = entry.fiber.runtime?.Config;
  const config = entry.fiber.effectiveConfig;
  const hot = schema?.dict?.memberModel?.meta?.volatile === true
    && schema?.dict?.memberLlmProvider?.meta?.volatile === true;
  const read = value => value && typeof value.get === 'function' ? value.get() : value;
  if (config && !activationIds.has(config)) activationIds.set(config, randomUUID());
  return {
    available: true, hot, instance: config ? activationIds.get(config) : null,
    provider: read(config?.memberLlmProvider) ?? '',
    model: read(config?.memberModel) ?? '',
  };
}
export function switchStatus(ctx) {
  const newSession = ctx.agentDefaultModel.currentSelection();
  const members = teamInfo(ctx);
  return {newSession, members, revision: digest({newSession, members})};
}
export async function catalog(ctx) {
  const providers = ctx.llm.listProviders();
  const results = await Promise.all(providers.map(async provider => {
    try {
      const models = await ctx.llm.listModels(provider.id);
      const resolved = await Promise.all(models.map(async model => {
        const info = await ctx.llm.resolveModelInfo(provider.id, model.id);
        return {
          id: model.id, name: model.name ?? model.id,
          input: info.inputModalities ?? model.inputModalities ?? ['text'],
          contextWindow: info.context?.contextWindow,
          maxTokens: info.defaultMaxTokens,
          efforts: info.reasoning?.efforts?.map(effort => ({id: effort.id, name: effort.name})) ?? [],
        };
      }));
      return {group: {id: provider.id, name: provider.name ?? provider.id, models: resolved}};
    } catch {
      // Do not echo provider request errors: they may carry headers or credentials.
      return {failure: {id: provider.id, name: provider.name ?? provider.id, message: '渠道模型目录加载失败'}};
    }
  }));
  return {...switchStatus(ctx), groups: results.flatMap(r => r.group ? [r.group] : []),
    failures: results.flatMap(r => r.failure ? [r.failure] : [])};
}
export async function applySwitch(ctx, request) {
  const allowed = new Set(['provider', 'model', 'reasoningEffort', 'targets', 'revision']);
  if (Object.keys(request).some(k => !allowed.has(k))) throw fault('不支持的参数');
  const {provider, model, targets, revision} = request;
  if (typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim()) {
    throw fault('请选择完整的渠道和模型');
  }
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 2
    || new Set(targets).size !== targets.length || targets.some(t => !['newSession', 'members'].includes(t))) {
    throw fault('请选择有效的应用范围');
  }
  if (typeof revision !== 'string' || revision !== switchStatus(ctx).revision) {
    throw fault('设置已在其它位置更新，请刷新后重试', 409);
  }
  if (!ctx.llm.listProviders().some(p => p.id === provider)) throw fault('该渠道未加载');
  if (!(await ctx.llm.listModels(provider)).some(m => m.id === model)) throw fault('该模型不在渠道目录中');
  const selection = {provider, model};
  if (request.reasoningEffort !== undefined && request.reasoningEffort !== '') {
    if (typeof request.reasoningEffort !== 'string') throw fault('无效的推理档位');
    selection.reasoningEffort = request.reasoningEffort;
  }
  // Resolves route/credentials/options locally; never sends a paid completion.
  try {await ctx.llm.resolveCallConfig(selection);} catch {throw fault('模型路由或凭据不可用，请检查渠道配置');}
  if (revision !== switchStatus(ctx).revision) throw fault('设置已变化，请刷新后重试', 409);
  const before = switchStatus(ctx);
  if (targets.includes('members') && (!before.members.available || !before.members.hot)) {
    throw fault('团队热切换补丁未加载，拒绝重挂团队插件；请先完成安装', 409);
  }
  const applied = [];
  let memberUid;
  if (targets.includes('members')) {
    const entry = teamEntry(ctx);
    const originalFiber = entry.fiber;
    const originalEffective = originalFiber.effectiveConfig;
    const originalModelRef = originalEffective.memberModel;
    const originalProviderRef = originalEffective.memberLlmProvider;
    memberUid = originalFiber.uid;
    await ctx.configEditor.edit(entry, current => {
      // Official editor holds its file/Loader locks here. Preserve all other raw fields.
      if ((current.memberLlmProvider ?? '') !== before.members.provider
        || (current.memberModel ?? '') !== before.members.model) {
        throw fault('团队默认模型已被其它页面更改', 409);
      }
      return {...current, memberLlmProvider: provider, memberModel: model};
    });
    const live = teamInfo(ctx);
    const activeFiber = teamEntry(ctx)?.fiber;
    if (activeFiber !== originalFiber || activeFiber.state !== 2
      || activeFiber.effectiveConfig !== originalEffective
      || activeFiber.effectiveConfig.memberModel !== originalModelRef
      || activeFiber.effectiveConfig.memberLlmProvider !== originalProviderRef
      || live.provider !== provider || live.model !== model) {
      throw fault('团队热更新未通过核验，请刷新检查', 500);
    }
    applied.push('members');
  }
  if (targets.includes('newSession')) {
    try {
      await ctx.agentDefaultModel.saveSelection(selection);
      const live = ctx.agentDefaultModel.currentSelection();
      if (live.provider !== provider || live.model !== model) throw fault('默认模型保存后读回不一致', 500);
      applied.push('newSession');
    } catch (error) {
      // Cross-entry writes are not one transaction. Report partial application honestly.
      return {...switchStatus(ctx), applied, partial: true, error: '新会话默认模型保存失败；已应用的范围未回滚'};
    }
  }
  return {...switchStatus(ctx), applied, partial: false, memberInstanceRetained: memberUid === undefined ? null : true};
}

export function apply(ctx) {
  // Existing-member route is installed by the owning AgentTeams adapter context.
  let queue = Promise.resolve();
  ctx.inject(['webServer', 'connection'], scoped => {
    scoped.effect(() => scoped.webServer.register({kind: 'exact', path: API_PATH,
      async handler(req, res) {
        try {
          const rejection = scoped.connection.requestRejection(req);
          if (rejection !== undefined) return reply(res, rejection, {error: '访问未授权'});
          if (req.method === 'GET') return reply(res, 200, await catalog(ctx));
          if (req.method !== 'POST') {
            res.setHeader('allow', 'GET, POST');
            return reply(res, 405, {error: '不支持的请求方法'});
          }
          // Authentication, canonical same-origin, CSRF fence before parsing or writing.
          const origin = req.headers.origin;
          if (!origin || req.headers['sec-fetch-site'] === 'cross-site') throw fault('拒绝跨站写请求', 403);
          let parsed;
          try {parsed = new URL(origin);} catch {throw fault('Origin 不匹配', 403);}
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.headers.host
            || parsed.pathname !== '/' || parsed.search || parsed.hash) throw fault('Origin 不匹配', 403);
          if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw fault('请发送 application/json', 415);
          const payload = await jsonBody(req);
          const run = queue.then(() => applySwitch(ctx, payload));
          queue = run.catch(() => {});
          return reply(res, 200, await run);
        } catch (error) {
          const status = error instanceof SwitchFault ? error.status : 500;
          if (status === 500) ctx.logger.warn('model-switch: application failed (no provider credentials logged)');
          reply(res, status, {error: status === 500 ? '应用失败，请刷新核对当前设置' : error.message});
        }
      }
    }), 'web-model-switch: authenticated route');
  });
}
