'use strict';
const React = require('react');
const { Button, Menu, Modal, Toast, Tooltip, IconCheckOutlineRegular, IconDataOutlineRegular,
  IconSettingsOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
const { STORAGE_KEY, rolesFor, roleLabel, addExecution, removeExecution, syncShortcuts, PresetStore,
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

function ConfigDialog({ directory, presets, shortcuts, onClose }) {
  const stored = useStore(presets);
  const catalog = useStore(directory.store);
  const [initial] = React.useState(() => ({ revision: stored.revision, presets: stored.presets }));
  const [draft, setDraft] = React.useState(initial.presets);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [loaded, setLoaded] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    directory.load().then(() => { if (live) setLoaded(true); })
      .catch(err => { if (live) setError(err.message || '无法读取模型目录。'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [directory]);
  const stale = stored.revision !== initial.revision;
  const save = () => {
    try {
      for (const role of rolesFor(draft)) if (draft[role]) validateSelection(catalog.groups, draft[role]);
      presets.save(draft, initial.revision);
      onClose();
    } catch (err) { setError(err.message || '模型预设保存失败。'); }
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
            onClick: () => { setDraft(current => removeExecution(current, role)); setError(null); }
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
              ...model.reasoning.efforts.map(level => h('option', { key: level.id, value: level.id }, level.name)))) : null));
    }),
    h(Button, { disabled: loading || !!stored.error || stale, 'data-model-roles-add': '',
      onClick: () => { setDraft(current => addExecution(current)); setError(null); }
    }, '添加执行模型'),
    catalog.failures.length ? h('p', { className: 'dsh-model-roles-help' }, '部分提供方目录加载失败；只列出当前可用模型。') : null,
    stored.error || stale || error ? h('p', { role: 'alert', className: 'dsh-model-roles-error' },
      stored.error || (stale ? '配置已在其他窗口修改，请关闭后重新打开。' : error)) : null));
}

function Toolbar({ sessionId, directory, controller, presets, shortcuts, available }) {
  const saved = useStore(presets);
  const state = useStore(directory.store);
  const bindings = useStore(shortcuts.catalog);
  const [open, setOpen] = React.useState(false);
  const [config, setConfig] = React.useState(false);
  React.useEffect(() => {
    if (!available) return;
    directory.load().catch(error => controller.notify(error.message || '模型目录加载失败。', false));
  }, [directory, available, controller]);
  if (!available) return null;
  const busy = state.status === 'selecting' || state.status === 'loading';
  // 单一触发器：只占一个按钮的宽度，避免挤压模型位。
  const activeRole = rolesFor(saved.presets).find(role => sameSelection(state.current, saved.presets[role]));
  const triggerLabel = activeRole ? roleLabel(activeRole) : '模型预设';
  const activeModel = activeRole ? modelTitle(saved.presets[activeRole], state.groups) : '未配置';
  const items = [
    { type: 'label', id: 'roles', text: '切换模型' },
    ...rolesFor(saved.presets).map(role => ({
      id: role,
      label: roleLabel(role),
      disabled: busy,
      shortcut: shortcutOf(bindings, role),
      icon: sameSelection(state.current, saved.presets[role]) ? h(IconCheckOutlineRegular, { size: 16 }) : undefined
    })),
    { type: 'separator', id: 'sep' },
    { id: 'config', label: '配置模型预设…', icon: h(IconSettingsOutlineRegular, { size: 16 }) }
  ];
  return h(React.Fragment, null,
    h(Menu, {
      open, autoFocus: false, align: 'start', side: 'top', portal: true, compact: true,
      anchor: h(Tooltip, { label: `${activeRole ? roleLabel(activeRole) : '模型预设'}：${activeModel}` },
        h(Button, {
          variant: 'toolbar', size: 'sm', disabled: busy,
          'aria-label': `模型预设快捷切换，当前${triggerLabel}`,
          'aria-haspopup': 'menu', 'aria-expanded': open,
          'data-dsh-model-roles': '', 'data-dsh-model-role-active': activeRole || 'none',
          icon: h(IconDataOutlineRegular, { size: 16 }),
          onClick: () => setOpen(current => !current)
        }, triggerLabel)),
      items,
      selectedId: activeRole,
      onSelect: id => {
        setOpen(false);
        if (id === 'config') { presets.reload(); setConfig(true); return; }
        void controller.switchTo(id, sessionId);
      },
      onClose: () => setOpen(false)
    }),
    config ? h(ConfigDialog, { directory, presets, shortcuts, onClose: () => setConfig(false) }) : null);
}

/** Read the effective key labels for one role so the menu row shows the current binding. */
function shortcutOf(bindings, role) {
  const entry = bindings.find(item => item.id === `model-roles.${role}`);
  return entry?.keys.length ? { keys: entry.keys, aria: entry.aria } : undefined;
}

function Notification({ source }) {
  const state = useStore(source);
  if (!state) return null;
  return h(Toast, { key: state.id, text: state.text, tone: state.success ? 'success' : undefined,
    holdMs: state.success ? 3000 : 6000,
    onDone: () => source.clear(state.id) });
}

// Cordis 服务调用沿调用者的注入作用域解析；directoryFor 的传递依赖也需显式声明。
const inject = ['slots', 'modelDirectories', 'sessions', 'shortcuts', 'layout', 'remote', 'remote.session'];
function apply(ctx) {
  let alive = true;
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
      shortcuts: ctx.shortcuts, available: ctx.sessions.subagentAddress(sessionId) === undefined })
  }, Toolbar));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'model-roles.notice', inject: () => ({ source })
  }, Notification));
}
module.exports = { inject, apply };
