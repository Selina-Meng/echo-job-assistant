/* Shared record operations for the sidebar and fullscreen editor. */
globalThis.EchoRecordClient = (() => {
  const loadRecords = () => new Promise(resolve => {
    chrome.storage.local.get(['records'], data => resolve(data.records || []));
  });

  async function request(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...data });
    if (!response?.ok) throw Error(response?.error || '保存失败，请保留输入后重试');
    return response.data;
  }

  async function loadUndo() {
    const data = await chrome.storage.local.get(['recordsUndo', 'recordsMergeUndo']);
    const merge = data.recordsMergeUndo;
    return merge && (!data.recordsUndo || merge.at >= data.recordsUndo.at)
      ? { ...merge, merge: true }
      : data.recordsUndo || null;
  }

  function create({ source, getRecords, onRecords, undoButton }) {
    let drafts = {};
    try { drafts = JSON.parse(sessionStorage.getItem('recordDrafts') || '{}'); } catch (_) {}
    const pendingSaves = new Map();

    function storeDrafts() {
      try { sessionStorage.setItem('recordDrafts', JSON.stringify(drafts)); } catch (_) {}
    }

    function rememberDraft(id, patch) {
      drafts[id] = { ...drafts[id], ...patch };
      storeDrafts();
    }

    async function refreshUndoButton() {
      const button = undoButton();
      if (!button) return;
      const undo = await loadUndo();
      button.disabled = !undo;
      button.title = undo ? '撤销：' + (undo.label || '记录操作') : '没有可撤销的操作';
    }

    async function savePatch(id, patch, preserveUndo, base) {
      base = base || getRecords().find(record => record.id === id);
      const expected = base ? Object.fromEntries(Object.keys(patch)
        .filter(key => !['greetingState', 'greetingCopiedAt'].includes(key))
        .map(key => [key, base[key] ?? null])) : {};
      try {
        const data = await request('AGENT_UPDATE_RECORD', {
          id, patch, expected, preserveUndo: !!preserveUndo, source
        });
        for (const key of Object.keys(patch)) {
          if (JSON.stringify(drafts[id]?.[key]) === JSON.stringify(patch[key])) delete drafts[id][key];
        }
        if (!Object.keys(drafts[id] || {}).length) delete drafts[id];
        if (base) Object.assign(base, patch);
        storeDrafts();
        onRecords(await loadRecords());
        return data;
      } catch (error) {
        alert('保存失败：' + error.message + '。本页保留了未保存输入，请勿清空。');
        throw error;
      }
    }

    function updateRecord(id, patch, preserveUndo, base) {
      rememberDraft(id, patch);
      const previous = pendingSaves.get(id) || Promise.resolve();
      const run = previous.catch(() => {}).then(() => savePatch(id, patch, preserveUndo, base));
      pendingSaves.set(id, run);
      run.finally(() => {
        if (pendingSaves.get(id) === run) pendingSaves.delete(id);
      }).catch(() => {});
      return run;
    }

    async function deleteRecordsWithUndo(_records, ids, label) {
      await request('AGENT_DELETE_RECORDS', { ids: [...ids], label });
      await refreshUndoButton();
      return loadRecords();
    }

    async function restoreUndo() {
      const undo = await loadUndo();
      if (!undo) return null;
      await request(undo.merge ? 'AGENT_UNDO_MERGE' : 'AGENT_UNDO_RECORDS');
      onRecords(await loadRecords());
      await refreshUndoButton();
      return undo;
    }

    async function migrateRecordStatuses() {
      await request('AGENT_MIGRATE_RECORDS');
      onRecords(await loadRecords());
    }

    async function mergeSelected(ids) {
      const preview = await request('AGENT_MERGE_RECORDS', { ids, preview: true });
      if (!preview.groups.length) {
        alert('没有相同平台岗位标识的重复记录。');
        return false;
      }
      if (!confirm(preview.summary + '\n冲突字段保留主记录值，其他版本完整保存在合并历史中；可在记录页撤销。确认合并？')) return false;
      await request('AGENT_MERGE_RECORDS', { ids, stamp: preview.stamp });
      onRecords(await loadRecords());
      await refreshUndoButton();
      return true;
    }

    return {
      recordDrafts: drafts, rememberDraft, updateRecord, refreshUndoButton,
      deleteRecordsWithUndo, restoreUndo, migrateRecordStatuses, mergeSelected
    };
  }

  return { create, loadRecords, request };
})();
