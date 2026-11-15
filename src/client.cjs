'use strict';
const React = require('react');
const { Button, Modal, Switch, Toast, Tooltip, IconDataOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
const { STORAGE_KEY, rolesFor, roleLabel, addExecution, removeExecution, removeTeamSlot, syncShortcuts, PresetStore,
  RoleSwitcher, sameSelection, findModel, validateSelection, currentMainSession, shortcutFor } = require('./core.cjs');
const h = React.createElement;

const css = `
.dsh-model-roles-config{display:flex;flex-direction:column;gap:20px;max-height:60vh;overflow-y:auto;padding:2px}
.dsh-model-roles-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsh-model-roles-row{display:flex;align-items:flex-end;gap:10px;min-width:0}
.dsh-model-roles-control{display:flex;flex-direction:column;gap:8px}
.dsh-model-roles-model{flex:1;min-width:0}
.dsh-model-roles-effort{flex:0 0 112px;min-width:0}
.dsh-model-roles-field{display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dsh-model-roles-select{width:100%;min-width:0;height:36px;padding:0 10px;font:inherit;color-scheme:light dark;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm)}
.dsh-model-roles-select option,.dsh-model-roles-select optgroup{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-model-roles-select:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-model-roles-team{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px}
.dsh-model-roles-team-label{font-size:13px;color:var(--dsw-alias-label-secondary)}
.dsh-model-roles-team-note{color:var(--dsw-alias-label-tertiary)}
.dsh-model-roles-help{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dsh-model-roles-error{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}
`;

function useStore(store) {
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function modelTitle(selection, groups) {
  if (!selection) return '未配置';
  const name = findModel(groups, selection)?.name || `${selection.provider}/${selection.model}`;
  return `${name}${selection.reasoningEffort ? ` · ${selection.reasoningEffort}` : ''}`;
}

/** Default binding for display before the slot is saved and registered. */
function defaultKeyLabel(role) {
  const binding = shortcutFor(role, () => undefined, () => {}).defaults['web:windows'];
  if (!binding) return '';
  const mac = /Mac|iPhone|iPad/.test(window.navigator?.platform || '');
  return `${mac ? '⌘' : 'Ctrl'} + Alt + ${binding.code.slice(5)}`;
}

function ConfigDialog({ directory, presets, shortcuts, sessionId, team, onClose }) {
  const stored = useStore(presets);
  const catalog = useStore(directory.store);
  const [initial] = React.useState(() => ({ revision: stored.revision, presets: stored.presets }));
  const [draft, setDraft] = React.useState(initial.presets);
  const [teamDraft, setTeamDraft] = React.useState(() => ({ ...stored.team }));
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [loaded, setLoaded] = React.useState(false);
  // 自己保存成功后 revision 会前进；若因团队开关失败继续留在弹框里，不应误判成“其他窗口修改”。
  const [savedRevision, setSavedRevision] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    directory.load().then(() => { if (live) setLoaded(true); })
      .catch(err => { if (live) setError(err.message || '无法读取模型目录。'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [directory]);
  const stale = stored.revision !== (savedRevision ?? initial.revision);
  const teamReady = Boolean(team?.available);
  const save = () => {
    try {
      for (const role of rolesFor(draft)) if (draft[role]) validateSelection(catalog.groups, draft[role]);
      // 上一次保存已推进 revision；重试保存必须基于最新 revision，否则会误报“其他窗口修改”。
      presets.save(draft, savedRevision ?? initial.revision, teamDraft);
    } catch (err) { setError(err.message || '模型预设保存失败。'); return; }
    setSavedRevision(presets.getSnapshot().revision);
    // 预设是团队协作状态的准绳：保存当前生效预设或重试时都重新下发，避免失败后无法补救。
    const active = rolesFor(draft).find(role => sameSelection(catalog.current, draft[role]));
    const flag = active ? teamDraft[active] : undefined;
    if (!active || typeof flag !== 'boolean' || !teamReady) { onClose(); return; }
    return team.apply(sessionId, flag).then(failure => {
      if (failure) { setError(failure); return; }
      onClose();
    });
  };
  const bindings = useStore(shortcuts.catalog);
  const keyLabel = role => {
    const registered = bindings.find(item => item.id === `model-roles.${role}`);
    return registered ? registered.keys.join('') : defaultKeyLabel(role);
  };
  return h(Modal, {
    open: true, onClose, title: '规划／执行模型', closeLabel: '关闭', shortcutModal: 'model-roles.config',
    footer: h(React.Fragment, null,
      h(Button, { onClick: onClose }, '取消'),
      h(Button, { variant: 'primary', disabled: loading || !loaded || !!stored.error || stale, onClick: save, 'data-model-roles-save': '' }, '保存'))
  }, h('div', { className: 'dsh-model-roles-config' },
    ...rolesFor(draft).map((role, index) => {
      const selection = draft[role];
      const model = findModel(catalog.groups, selection);
      const selectedKey = selection ? JSON.stringify([selection.provider, selection.model]) : '';
      return h('div', { key: role, className: 'dsh-model-roles-field' },
        h('div', { className: 'dsh-model-roles-heading' },
          h('label', { htmlFor: `dsh-model-roles-${role}` }, roleLabel(role) + (keyLabel(role) ? ` · ${keyLabel(role)}` : '')),
          role !== 'planning' ? h(Button, { size: 'sm', disabled: loading || !!stored.error || stale,
            'aria-label': `删除${roleLabel(role)}`,
            onClick: () => {
              setDraft(current => removeExecution(current, role));
              setTeamDraft(current => removeTeamSlot(draft, current, role));
              setError(null);
            }
          }, '删除') : null),
        h('div', { className: 'dsh-model-roles-row' },
          h('div', { className: 'dsh-model-roles-control dsh-model-roles-model' },
            h('select', {
              id: `dsh-model-roles-${role}`, className: 'dsh-model-roles-select', value: selectedKey,
              disabled: loading, 'data-modal-autofocus': index === 0 ? '' : undefined,
              onChange: event => {
                const key = event.target.value;
                let next = null;
                if (key) {
                  const [provider, modelId] = JSON.parse(key);
                  const candidate = findModel(catalog.groups, { provider, model: modelId });
                  if (!candidate) { setError('模型目录已变化，请重新打开配置。'); return; }
                  next = { provider, model: modelId, ...(candidate.reasoning?.defaultEffort !== undefined
                    ? { reasoningEffort: candidate.reasoning.defaultEffort } : {}) };
                }
                setDraft(current => ({ ...current, [role]: next }));
                setError(null);
              }
            },
              h('option', { value: '' }, loading ? '正在读取模型目录…' : '未配置'),
              selection && !model ? h('option', { value: selectedKey, disabled: true }, `${selection.provider}/${selection.model}（不可用）`) : null,
              ...catalog.groups.map(group => h('optgroup', { label: group.name, key: group.id },
                ...group.models.map(item => h('option', { value: JSON.stringify([group.id, item.id]), key: item.id }, item.name)))))),
          model?.reasoning ? h('div', { className: 'dsh-model-roles-control dsh-model-roles-effort' },
            h('select', {
              id: `dsh-model-roles-${role}-effort`, className: 'dsh-model-roles-select',
              'aria-label': `${roleLabel(role)}推理强度`,
              value: selection.reasoningEffort ?? '', disabled: loading,
              onChange: event => {
                const effort = event.target.value;
                setDraft(current => {
                  const next = { ...current[role] };
                  if (effort) next.reasoningEffort = effort;
                  else delete next.reasoningEffort;
                  return { ...current, [role]: next };
                });
                setError(null);
              }
            }, h('option', { value: '' }, '模型默认'),
              selection.reasoningEffort && !model.reasoning.efforts.some(level => level.id === selection.reasoningEffort)
                ? h('option', { value: selection.reasoningEffort, disabled: true }, `${selection.reasoningEffort}（不可用）`) : null,
              ...model.reasoning.efforts.map(level => h('option', { key: level.id, value: level.id }, level.name)))) : null),
        teamReady ? h('div', { className: 'dsh-model-roles-team' },
          h('span', { className: 'dsh-model-roles-team-label' }, '启用智能体团队协作',
            // 未记录时不改团队状态；保存时会连同预设一起记下开关。
            teamDraft[role] === undefined ? h('span', { className: 'dsh-model-roles-team-note' }, ' · 未设置') : null),
          h(Switch, {
            checked: teamDraft[role] === true,
            disabled: loading || !!stored.error || stale,
            label: `${roleLabel(role)}启用智能体团队协作`,
            'data-model-roles-team': role,
            onChange: enabled => {
              setTeamDraft(current => ({ ...current, [role]: enabled }));
              setError(null);
            }
          })) : null);
    }),
    h(Button, { disabled: loading || !!stored.error || stale, 'data-model-roles-add': '',
      onClick: () => { setDraft(current => addExecution(current)); setError(null); }
    }, '添加执行模型'),
    catalog.failures.length ? h('p', { className: 'dsh-model-roles-help' }, '部分提供方目录加载失败；只列出当前可用模型。') : null,
    stored.error || stale || error ? h('p', { role: 'alert', className: 'dsh-model-roles-error' },
      stored.error || (stale ? '配置已在其他窗口修改，请关闭后重新打开。' : error)) : null));
}

function Toolbar({ directory, controller, presets, shortcuts, available, sessionId, team }) {
  const saved = useStore(presets);
  const state = useStore(directory.store);
  const [config, setConfig] = React.useState(false);
  React.useEffect(() => {
    if (!available) return;
    directory.load().catch(error => controller.notify(error.message || '模型目录加载失败。', false));
  }, [directory, available, controller]);
  if (!available) return null;
  const busy = state.status === 'selecting' || state.status === 'loading';
  const activeRole = rolesFor(saved.presets).find(role => sameSelection(state.current, saved.presets[role]));
  const triggerLabel = activeRole ? roleLabel(activeRole) : '模型预设';
  const activeModel = activeRole ? modelTitle(saved.presets[activeRole], state.groups) : '未配置';
  // 单一触发器：点击直接打开配置窗口，不再弹出中间菜单。
  return h(React.Fragment, null,
    // composer 的 will-change: transform 会改变 fixed 包含块；气泡需脱离其滚动布局。
    h(Tooltip, { label: `${triggerLabel}：${activeModel}（点击配置模型预设）`, portal: true, side: 'top' },
      h(Button, {
        variant: 'toolbar', size: 'sm', disabled: busy,
        'aria-label': `配置模型预设，当前${triggerLabel}`,
        'aria-haspopup': 'dialog',
        'data-dsh-model-roles': '', 'data-dsh-model-role-active': activeRole || 'none',
        icon: h(IconDataOutlineRegular, { size: 16 }),
        onClick: () => { presets.reload(); setConfig(true); }
      }, triggerLabel)),
    config ? h(ConfigDialog, { directory, presets, shortcuts, sessionId, team, onClose: () => setConfig(false) }) : null);
}

function Notification({ source }) {
  const state = useStore(source);
  if (!state) return null;
  return h(Toast, { key: state.id, text: state.text, tone: state.success ? 'success' : undefined,
    holdMs: state.success ? 3000 : 6000,
    onDone: () => source.clear(state.id) });
}

/**
 * 团队协作开关由内置 agent-team bundle 提供；它未装载或当前会话不是主会话时不显示这一行。
 * 用非严格反射探测命名空间，避免插件装载顺序导致 apply 直接抛错。
 */
function teamBridge(ctx) {
  const namespace = () => {
    try { return ctx.reflect?.get?.('remote.agentTeams', false) || null; } catch { return null; }
  };
  return {
    get available() { return Boolean(namespace()); },
    async apply(sessionId, enabled) {
      const remote = namespace();
      if (!remote) return '团队协作开关不可用，请确认当前 DSH 已启用智能体团队协作。';
      try {
        const response = await remote.setEnabled(sessionId, enabled);
        return response?.ok ? null : (response?.error?.message || '团队协作开关未保存，请重试。');
      } catch (error) {
        if (error?.code === 'TEAM_LEAD_REQUIRED') return '只能在主会话上切换团队协作。';
        return error?.message || '团队协作开关未保存，请重试。';
      }
    }
  };
}

// Cordis 服务调用沿调用者的注入作用域解析；directoryFor 的传递依赖也需显式声明。
const inject = ['slots', 'modelDirectories', 'sessions', 'shortcuts', 'layout', 'remote', 'remote.session'];
function apply(ctx) {
  let alive = true;
  const team = teamBridge(ctx);
  const presets = new PresetStore({
    getItem: key => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value)
  });
  let notice = null;
  let sequence = 0;
  const listeners = new Set();
  const publish = () => { for (const listener of listeners) listener(); };
  const source = {
    getSnapshot: () => notice,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    clear: id => { if (notice?.id === id) { notice = null; publish(); } }
  };
  const controller = new RoleSwitcher({
    presets, directoryFor: id => ctx.modelDirectories.directoryFor(id),
    isAvailable: id => ctx.sessions.subagentAddress(id) === undefined && !!ctx.sessions.binding(id),
    isAlive: () => alive,
    setTeam: (sessionId, enabled) => team.apply(sessionId, enabled),
    notify: (text, success) => { notice = { id: ++sequence, text, success }; publish(); }
  });
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'dsh-model-roles';
    style.textContent = css;
    document.head.appendChild(style);
    const onStorage = event => { if (event.key === STORAGE_KEY || event.key === null) presets.reload(); };
    window.addEventListener('storage', onStorage);
    return () => { alive = false; style.remove(); window.removeEventListener('storage', onStorage); listeners.clear(); };
  }, 'model-roles: lifecycle');
  ctx.effect(() => syncShortcuts(presets,
    definition => ctx.shortcuts.register(definition),
    () => currentMainSession(ctx.sessions, ctx.layout),
    (role, sessionId) => controller.switchTo(role, sessionId)), 'model-roles: dynamic shortcuts');
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'model-roles', order: 90,
    inject: sessionId => ({ directory: ctx.modelDirectories.directoryFor(sessionId), controller, presets,
      shortcuts: ctx.shortcuts, sessionId, team, available: ctx.sessions.subagentAddress(sessionId) === undefined })
  }, Toolbar));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'model-roles.notice', inject: () => ({ source })
  }, Notification));
}
module.exports = { inject, apply };
