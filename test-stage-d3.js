const fs = require('fs');
const vm = require('vm');
const app = fs.readFileSync(__dirname + '/app.html', 'utf8');
function fnSource(name) {
  const start = app.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('Missing function ' + name);
  const brace = app.indexOf('{', start); let depth = 0, quote = null, esc = false;
  for (let i = brace; i < app.length; i++) {
    const c = app[i];
    if (quote) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error('Unclosed function ' + name);
}
const names = ['barcodeCommitJournal_', 'barcodeCommitClaim_', 'barcodeCommitIntent_', 'barcodeCommitFinalize_', 'barcodeCommitDuplicateOutcome_'];
const sandbox = {
  BARCODE_KASIR_REQUESTS: new Map(),
  barcodeLedgerWrite_: () => {},
  Date,
  String
};
vm.createContext(sandbox);
vm.runInContext(names.map(fnSource).join('\n') + '\nthis.api={barcodeCommitClaim_,barcodeCommitIntent_,barcodeCommitFinalize_,barcodeCommitDuplicateOutcome_};', sandbox);
const e = {status:'processing', commitState:'none', updatedAt:Date.now()};
sandbox.BARCODE_KASIR_REQUESTS.set('req-1', e);
if (!sandbox.api.barcodeCommitClaim_('req-1').ok) throw new Error('first claim should pass');
if (!sandbox.api.barcodeCommitIntent_('req-1','P-1')) throw new Error('commit intent should pass');
if (sandbox.api.barcodeCommitIntent_('req-1','P-1')) throw new Error('second commit intent must be blocked');
sandbox.api.barcodeCommitFinalize_('req-1','committed');
if (sandbox.api.barcodeCommitClaim_('req-1').ok) throw new Error('committed request must never be replayed');
if (sandbox.api.barcodeCommitDuplicateOutcome_('req-1').status !== 'DUPLICATE_SUPPRESSED') throw new Error('duplicate outcome missing');
const interrupted = {status:'interrupted',commitState:'intent',productId:'P-2'};
sandbox.BARCODE_KASIR_REQUESTS.set('req-2', interrupted);
if (sandbox.api.barcodeCommitClaim_('req-2').ok) throw new Error('interrupted request must fail closed');
if (!app.includes("commitState:String(e.commitState||'none')") || !app.includes("barcodeCommitFinalize_(requestId,'committed')")) throw new Error('commit journal persistence/finalization missing');
const scanner = fs.readFileSync(__dirname + '/index_scanner.html', 'utf8');
if (!scanner.includes("d.type==='APOTEK_SCANNER_RESULT_ACK'")) throw new Error('scanner ACK listener missing');
console.log('Stage D3 exactly-once journal tests: PASS (claim, intent, duplicate block, committed replay block, interrupted fail-closed)');
