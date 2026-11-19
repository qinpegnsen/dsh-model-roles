'use strict';

const STORAGE_KEY = 'dsh.model-roles.v1';
const emptyPresets = () => ({ preset1: null, preset2: null, preset3: null });

/** Preset slots are named preset1, preset2, preset3… in display order. */
const presetKey = number => `preset${number}`;

function presetNumber(role) {
  if (!/^preset[1-9][0-9]*$/.test(role)) return null;
  const number = Number(role.slice(6));
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

/** Roles written by 0.1.x–0.2.x: one planning slot plus execution, execution2… */
function legacyNumber(role) {
  if (role === 'execution') return 1;
  if (!/^execution[1-9][0-9]*$/.test(role)) return null;
  const number = Number(role.slice(9));
  return Number.isSafeInteger(number) && number >= 2 ? number : null;
}

const legacyKey = number => (number === 1 ? 'execution' : `execution${number}`);

function legacyRoles(keys) {
  return ['planning', ...Object.keys(keys).filter(role => role !== 'planning')
    .sort((a, b) => legacyNumber(a) - legacyNumber(b))];
}

/** Keep only explicit booleans for known presets; unknown or non-boolean entries are dropped. */
function normalizeTeam(team) {
  const next = {};
  for (const [role, enabled] of Object.entries(team || {})) {
    if (typeof enabled === 'boolean' && presetNumber(role) !== null) next[role] = enabled;
  }
  return next;
}

function rolesFor(presets) {
  return Object.keys(presets).sort((a, b) => presetNumber(a) - presetNumber(b));
}

function roleLabel(role) {
  const number = presetNumber(role);
  if (number === null) throw new Error('未知模型预设。');
  return `预设模型${number}`;
}

/** Rebuild a per-role map over the slots left after `drop`, renumbering by position. */
function remapRoles(presets, values, drop) {
  const next = {};
  let number = 1;
  for (const role of rolesFor(presets)) {
    if (role === drop) continue;
    const key = presetKey(number++);
    if (Object.hasOwn(values, role)) next[key] = values[role];
  }
  return next;
}

/** Add one unconfigured preset slot at the end; returns a new preset object. */
function addPreset(presets) {
  return { ...presets, [presetKey(rolesFor(presets).length + 1)]: null };
}

/** Remove one preset slot and renumber the rest, preserving every selection. */
function removePreset(presets, role) {
  const roles = rolesFor(presets);
  if (!roles.includes(role)) throw new Error('该模型预设不存在。');
  if (roles.length <= 1) throw new Error('至少保留一个预设模型。');
  return remapRoles(presets, presets, role);
}

/** Move Team flags onto the same positions after a preset slot is removed. */
function removeTeamPreset(presets, team, role) {
  return remapRoles(presets, normalizeTeam(team), role);
}

function isSelection(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.model === 'string' && value.model.length > 0
    && (value.reasoningEffort === undefined || (typeof value.reasoningEffort === 'string' && value.reasoningEffort.length > 0))
    && Object.keys(value).every(key => ['provider', 'model', 'reasoningEffort'].includes(key));
}

const INVALID_DOCUMENT = '模型预设格式不正确或版本不受支持，请先检查本浏览器的插件配置。';

/** Team flags only accept explicit booleans on roles that still exist. */
function parseTeam(team, roles) {
  if (team === undefined) return {};
  if (team === null || typeof team !== 'object' || Array.isArray(team)) throw new Error(INVALID_DOCUMENT);
  const next = {};
  for (const [role, enabled] of Object.entries(team)) {
    if (typeof enabled !== 'boolean' || !roles.includes(role)) throw new Error(INVALID_DOCUMENT);
    next[role] = enabled;
  }
  return next;
}

/** Map 0.1.x–0.2.x roles onto flat preset positions: 规划模型→1，执行模型 N→N+1。 */
function migrateLegacy(presets) {
  return Object.fromEntries(legacyRoles(presets).map((role, index) => [presetKey(index + 1), presets[role]]));
}

function migrateTeam(team, legacyPresets) {
  const next = {};
  legacyRoles(legacyPresets).forEach((role, index) => {
    if (Object.hasOwn(team, role)) next[presetKey(index + 1)] = team[role];
  });
  return next;
}

/** Parse the stored document into flat presets plus the per-preset Team flags. */
function parseDocument(raw) {
  if (raw === null) return { presets: emptyPresets(), team: {} };
  const doc = JSON.parse(raw);
  const invalid = () => { throw new Error(INVALID_DOCUMENT); };
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || ![1, 2, 3, 4].includes(doc.version)
    || doc.presets === null || typeof doc.presets !== 'object' || Array.isArray(doc.presets)) invalid();
  const allowed = doc.version === 3 || doc.version === 4 ? ['version', 'presets', 'team'] : ['version', 'presets'];
  if (Object.keys(doc).some(key => !allowed.includes(key))) invalid();
  const keys = Object.keys(doc.presets);
  const validSelections = () => keys.some(role => doc.presets[role] !== null && !isSelection(doc.presets[role]));
  if (doc.version === 1) {
    // 0.1.x and the first 0.2.0 draft stored either two or three fixed slots.
    if (!Object.hasOwn(doc.presets, 'planning') || !Object.hasOwn(doc.presets, 'execution')
      || keys.some(role => !['planning', 'execution', 'execution2'].includes(role))
      || validSelections()) invalid();
    const legacy = { planning: doc.presets.planning, execution: doc.presets.execution, execution2: doc.presets.execution2 ?? null };
    return { presets: migrateLegacy(legacy), team: {} };
  }
  if (doc.version < 4) {
    if (!Object.hasOwn(doc.presets, 'planning')
      || keys.some(role => role !== 'planning' && legacyNumber(role) === null)
      || validSelections()) invalid();
    const roles = legacyRoles(doc.presets);
    if (roles.slice(1).some((role, index) => role !== legacyKey(index + 1))) invalid();
    const team = parseTeam(doc.version === 3 ? doc.team : undefined, roles);
    return { presets: migrateLegacy(doc.presets), team: migrateTeam(team, doc.presets) };
  }
  // Version 4 is the flat list: contiguous preset1…presetN, at least one slot.
  if (!keys.length || keys.some(role => presetNumber(role) === null) || validSelections()) invalid();
  const roles = rolesFor(doc.presets);
  if (roles.some((role, index) => role !== presetKey(index + 1))) invalid();
  return { presets: Object.fromEntries(roles.map(role => [role, doc.presets[role]])),
    team: parseTeam(doc.team, roles) };
}

function parsePresets(raw) {
  return parseDocument(raw).presets;
}

function sameSelection(a, b) {
  return a != null && b != null && a.provider === b.provider && a.model === b.model
    && a.reasoningEffort === b.reasoningEffort;
}

function findModel(groups, selection) {
  if (!selection) return undefined;
  return groups.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model);
}

function validateSelection(groups, selection) {
  if (!isSelection(selection)) throw new Error('尚未配置模型。');
  const model = findModel(groups, selection);
  if (!model) throw new Error(`预设模型当前不可用：${selection.provider}/${selection.model}。请重新配置，不会自动替换为其他模型。`);
  if (selection.reasoningEffort !== undefined
    && !model.reasoning?.efforts.some(level => level.id === selection.reasoningEffort)) {
    throw new Error('预设的推理强度当前不可用，请重新配置。');
  }
  return model;
}

class PresetStore {
  constructor(storage) {
    this.storage = storage;
    this.listeners = new Set();
    this.state = { presets: emptyPresets(), team: {}, revision: null, error: null };
    this.getSnapshot = () => this.state;
    this.subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    this.reload();
  }
  publish(state) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  reload() {
    try {
      const revision = this.storage.getItem(STORAGE_KEY);
      const { presets, team } = parseDocument(revision);
      this.publish({ presets, team, revision, error: null });
    } catch (error) {
      this.publish({ ...this.state, error: error.message || '无法读取模型预设。' });
    }
  }
  save(presets, expectedRevision, team = {}) {
    const raw = JSON.stringify({ version: 4, presets, team: normalizeTeam(team) });
    const checked = parseDocument(raw);
    const before = this.storage.getItem(STORAGE_KEY);
    parseDocument(before);
    if (before !== expectedRevision) {
      this.reload();
      throw new Error('模型预设已在其他窗口修改，请关闭配置后重新打开。');
    }
    this.storage.setItem(STORAGE_KEY, raw);
    const after = this.storage.getItem(STORAGE_KEY);
    if (after !== raw) {
      this.reload();
      throw new Error('模型预设保存后读回不一致，请重新打开配置核对。');
    }
    this.publish({ presets: checked.presets, team: checked.team, revision: raw, error: null });
  }
}

class RoleSwitcher {
  constructor({ presets, directoryFor, notify, isAvailable, isAlive = () => true, setTeam = async () => null }) {
    this.presets = presets;
    this.directoryFor = directoryFor;
    this.notify = notify;
    this.isAvailable = isAvailable;
    this.isAlive = isAlive;
    this.setTeam = setTeam;
    this.busy = new Set();
  }
  async switchTo(role, sessionId) {
    if (this.busy.has(sessionId)) return;
    this.busy.add(sessionId);
    try {
      if (!this.isAvailable(sessionId)) throw new Error('当前对话不支持切换模型。');
      this.presets.reload();
      const saved = this.presets.getSnapshot();
      if (saved.error) throw new Error(saved.error);
      if (!Object.hasOwn(saved.presets, role)) throw new Error('该模型预设已删除，请重新打开菜单。');
      const label = roleLabel(role);
      const selection = saved.presets[role];
      if (!selection) throw new Error(`请先点击“配置模型预设”，设置${label}。`);
      const directory = this.directoryFor(sessionId);
      const state = await directory.load();
      if (!this.isAlive()) return;
      if (!this.isAvailable(sessionId)) throw new Error('原对话已关闭，未切换模型。');
      const model = validateSelection(state.groups, selection);
      if (directory.store.getSnapshot().pending) throw new Error('当前对话正在切换模型，请稍后再试。');
      if (sameSelection(directory.store.getSnapshot().current, selection)) {
        this.notify(`当前已是${label}：${model.name}`, true);
        return;
      }
      const result = await directory.select({ ...selection });
      if (!this.isAlive()) return;
      if (!result.ok) throw new Error(result.error.message || result.error.code || '模型切换失败。');
      // 与内置选择器同源读回；不得把 RPC 受理当成切换完成。
      if (!sameSelection(directory.store.getSnapshot().current, selection)) {
        throw new Error('模型切换结果尚未同步，请核对输入框旁的当前模型，不要重复切换。');
      }
      // 团队协作标记随预设走：只应用明确记录过的预设，未记录的保持当前状态。
      const team = saved.team[role];
      if (typeof team === 'boolean') {
        const failure = await this.setTeam(sessionId, team);
        if (!this.isAlive()) return;
        if (failure) throw new Error(`已切换到${label}：${model.name}；但团队协作开关设置失败：${failure}`);
      }
      this.notify(`已切换到${label}：${model.name}；下次请求生效`, true);
    } catch (error) {
      if (this.isAlive()) this.notify(error.message || '模型切换失败。', false);
    } finally {
      this.busy.delete(sessionId);
    }
  }
}

function currentMainSession(sessions, layout) {
  if (layout.panelInfo.getSnapshot().activePanelId !== null) return undefined;
  const candidates = Object.values(sessions.list.getSnapshot().byId)
    .filter(item => (item.retainedBy.mainView ?? 0) > 0);
  if (candidates.length !== 1) return undefined;
  const id = candidates[0].id;
  return sessions.subagentAddress(id) === undefined && sessions.binding(id) ? id : undefined;
}

function shortcutFor(role, resolveTarget, switchTo) {
  // 预设模型 N 使用 DigitN（1–9），第 10 个复用 Digit0，更多预设由用户自行绑定。
  const number = presetNumber(role);
  if (number === null) throw new Error('未知模型预设。');
  const binding = number <= 10 ? { code: `Digit${number % 10}`, modifiers: ['primary', 'alt'] } : undefined;
  return {
    id: `model-roles.${role}`,
    label: () => `切换到${roleLabel(role)}`,
    aliases: [role, `${role} model`, roleLabel(role)],
    defaults: binding ? { 'web:macos': binding, 'web:windows': binding, 'desktop:macos': binding, 'desktop:windows': binding } : {},
    regions: ['page', 'editable'],
    modals: [],
    resolve: () => {
      const sessionId = resolveTarget();
      return sessionId === undefined ? { status: 'pass' } : {
        status: 'handled', run: () => { void switchTo(role, sessionId); }
      };
    }
  };
}

/** Keep registered shortcuts in step with the saved preset list. */
function syncShortcuts(presets, register, resolveTarget, switchTo) {
  const registered = new Map();
  const sync = () => {
    const snapshot = presets.getSnapshot();
    if (snapshot.error) return;
    const roles = rolesFor(snapshot.presets);
    for (const [role, dispose] of registered) {
      if (!roles.includes(role)) { dispose(); registered.delete(role); }
    }
    for (const role of roles) {
      if (!registered.has(role)) registered.set(role, register(shortcutFor(role, resolveTarget, switchTo)));
    }
  };
  const unsubscribe = presets.subscribe(sync);
  sync();
  return () => { unsubscribe(); for (const dispose of registered.values()) dispose(); registered.clear(); };
}

module.exports = { STORAGE_KEY, rolesFor, roleLabel, presetNumber, addPreset, removePreset,
  removeTeamPreset, normalizeTeam, parseDocument, syncShortcuts, parsePresets, sameSelection, findModel,
  validateSelection, PresetStore, RoleSwitcher, currentMainSession, shortcutFor };
