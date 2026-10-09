const { SCHEMA_VERSION, createDefaultSave } = require('./chapter');
const SAVE_KEY = 'science-river.chapter1.save';

function loadSave(storage) {
  try {
    const value = storage.getStorageSync(SAVE_KEY);
    if (!value || value.schemaVersion !== SCHEMA_VERSION) return createDefaultSave();
    return value;
  } catch (_) { return createDefaultSave(); }
}

function writeSave(storage, save) {
  const value = JSON.parse(JSON.stringify({ ...save, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now() }));
  storage.setStorageSync(SAVE_KEY, value);
  return value;
}

function resetSave(storage) {
  const save = createDefaultSave();
  storage.setStorageSync(SAVE_KEY, save);
  return save;
}

module.exports = { SAVE_KEY, loadSave, writeSave, resetSave };
