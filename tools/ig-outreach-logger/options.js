// options.js — сохранение настроек в chrome.storage.sync.

const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(['webhookUrl', 'ingestToken', 'defaultHours', 'defaultMode', 'ownAccount'], (cfg) => {
  if (cfg.webhookUrl) $('webhookUrl').value = cfg.webhookUrl;
  if (cfg.ingestToken) $('ingestToken').value = cfg.ingestToken;
  if (cfg.defaultHours) $('defaultHours').value = cfg.defaultHours;
  if (cfg.defaultMode) $('defaultMode').value = cfg.defaultMode;
  if (cfg.ownAccount) $('ownAccount').value = cfg.ownAccount;
});

$('save').addEventListener('click', () => {
  const cfg = {
    webhookUrl: $('webhookUrl').value.trim(),
    ingestToken: $('ingestToken').value.trim(),
    defaultHours: +$('defaultHours').value || 2,
    defaultMode: $('defaultMode').value,
    ownAccount: ($('ownAccount').value.trim() || 'pbpb.furn').replace(/^@/, '').replace(/\//g, '')
  };
  chrome.storage.sync.set(cfg, () => {
    const s = $('saved');
    s.hidden = false;
    setTimeout(() => { s.hidden = true; }, 1500);
  });
});
