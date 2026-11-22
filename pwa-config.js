/* Configure the deployed Google Apps Script Web App URL.
 * Keep this URL public; NEVER put user tokens, passwords, API keys or secrets here.
 */
window.APOTEK_PWA_CONFIG = Object.freeze({
  gasWebAppUrl: "https://script.google.com/macros/s/AKfycbxhtRJl_oxPdQDS5adWc7b6sANfeDkEcdhuqfkaZb85gSPPcoPyVKRmD9fyinjLkunw1Q/exec",
  appLabel: "APOTEK · SMART POS",
  apiProtocol:"pwa_api_v1",
  shellVersion:"1.4.0",
  auth:{accessTokenTtlSeconds:900,refreshTokenTtlSeconds:21600,storage:"memory-only"}
});
