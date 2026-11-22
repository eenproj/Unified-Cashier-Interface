/* Konfigurasi publik saja. Jangan pernah menaruh password/token/secret di sini. */
window.APOTEK_PWA_CONFIG=Object.freeze({
  gasWebAppUrl:"PASTE_DEPLOYED_APPS_SCRIPT_EXEC_URL_HERE",
  appLabel:"APOTEK · SMART POS",
  apiProtocol:"pwa_api_v1",
  shellVersion:"1.4.0",
  auth:{accessTokenTtlSeconds:900,refreshTokenTtlSeconds:21600,storage:"memory-only"}
});
