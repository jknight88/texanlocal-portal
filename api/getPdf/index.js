// GET /api/getPdf?id=SESSION_ID&key=DASHBOARD_KEY  or  ?id=SESSION_ID&pdfToken=TOKEN
const { BlobServiceClient } = require("@azure/storage-blob");
const jwt           = require("jsonwebtoken");
const STORAGE_CONN  = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER     = "enrollments";
const DASHBOARD_KEY = process.env.DASHBOARD_KEY || "changeme";
const JWT_SECRET    = process.env.JWT_SECRET || "e42f24e9f5cfe3558144a25a0b30c6458fc4bd5ab6a6271404a1e7b509404c72";

function maskPayment(payMethod, payDetail) {
  if (!payDetail) return { method: payMethod||'', rows: '' };
  const parts = payDetail.split('|');
  let rows = '';
  const r = (label, val) => `<tr><td style="padding:5pt 8pt;font-weight:700;background:#edf0f7;border:1pt solid #c8cdd8;width:38%;font-size:9pt;">${label}</td><td style="padding:5pt 8pt;background:#fff;border:1pt solid #c8cdd8;font-size:9pt;">${val||'&mdash;'}</td></tr>`;
  if (payMethod && payMethod.includes('Credit Card')) {
    const raw = (parts[1]||'').replace(/\s/g,'');
    const masked = raw.length > 4 ? '&bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; ' + raw.slice(-4) : raw;
    rows = r('Card Type', parts[0]||'')
         + r('Card Number', masked)
         + r('Name on Card', parts[2]||'')
         + r('Expiration', parts[3]?parts[3].replace('Exp:',''):'')
         + r('CVV', '&bull;&bull;&bull;')
         + r('Billing Address', parts[5]?parts[5].replace('Billing:',''):'');
  } else {
    const acct = (parts[1]||'').replace('Account:','');
    const maskedAcct = acct.length > 4 ? '&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull; ' + acct.slice(-4) : acct;
    rows = r('Routing Number', (parts[0]||'').replace('Routing:',''))
         + r('Account Number', maskedAcct)
         + r('Account Type',   (parts[2]||'').replace('Type:',''))
         + r('Account Holder', (parts[3]||'').replace('Holder:',''));
  }
  return { method: payMethod||'', rows };
}

module.exports = async function(context, req) {
  if (req.method === "OPTIONS") { context.res={status:200}; return; }

  const authKey     = req.query.key;
  const pdfTokenReq = req.query.pdfToken;
  let authorized    = (authKey === DASHBOARD_KEY);
  // Also accept portal JWT token
  if (!authorized) {
    const tokenParam = req.query.token || authKey || '';
    try {
      const decoded = jwt.verify(tokenParam, JWT_SECRET);
      if (decoded.role === 'admin') authorized = true;
    } catch(e) {}
  }

  const id = req.query.id;
  if (!id) { context.res={status:400,body:"Missing id"}; return; }

  const blobSvc   = BlobServiceClient.fromConnectionString(STORAGE_CONN);
  const container = blobSvc.getContainerClient(CONTAINER);
  const blob      = container.getBlockBlobClient(`${id}.json`);

  if (!authorized && pdfTokenReq) {
    try {
      const dlAuth   = await blob.downloadToBuffer();
      const recAuth  = JSON.parse(dlAuth.toString());
      authorized     = (recAuth.pdfToken === pdfTokenReq);
    } catch(e) { authorized = false; }
  }
  if (!authorized) { context.res={status:401,body:"Unauthorized"}; return; }

  try {
    const dl     = await blob.downloadToBuffer();
    const record = JSON.parse(dl.toString());
    if (record.status !== 'signed' && record.status !== 'client_signed') { context.res={status:400,body:"Agreement not yet signed."}; return; }

    const s  = record.signed || {};
    const fd = record.formData || {};
    const fmtDate = (v) => { try { return new Date(v).toLocaleString("en-US",{timeZone:"America/Chicago",dateStyle:"full",timeStyle:"short"}); } catch(e){ return v||""; } };
    const signedDateFmt = record.signedAt ? fmtDate(record.signedAt) : "";
    const repSignedFmt  = record.countersignedAt ? fmtDate(record.countersignedAt) : signedDateFmt;
    const pay = maskPayment(s.payMethod, s.payDetail);

    // Parse initials - stored as JSON {payment, tc, auth} or legacy comma string
    let initObj = {payment:'', tc:'', auth:'', adApproval:''};
    try {
      const raw = s.initials || '';
      if (raw.startsWith('{')) { initObj = JSON.parse(raw); }
      else { const p = raw.split(',').map(x=>x.trim()); initObj = {payment:p[0]||'',tc:p[1]||'',auth:p[2]||''}; }
    } catch(e) {}
    const initSig = (v) => v ? `<strong style="font-family:'Dancing Script',cursive;font-size:11pt;color:#00205B;font-weight:700;">${v}</strong>` : '<span style="color:#bbb;font-size:7.5pt;">—</span>';

    // Build zone rows from saved zones data
    let zoneRows = '';
    let zoneRowData = [];
    if (fd.zones && fd.zones.length > 0) {
      fd.zones.forEach(z => {
        const name    = z.zoneName   || z.id || '';
        const product = z.product    || '';
        const start   = z.startMonth || '';
        const rate    = z.rate       || '0.00';
        // Format start month from YYYY-MM to "Jan 2026"
        let startFmt = '';
        if(start) {
          const parts = start.split('-');
          const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          startFmt = (months[parseInt(parts[1])]||'') + ' ' + (parts[0]||'');
        }
        // Group by product — collect all zones for each product
        var existingProduct = zoneRowData.find(function(r){ return r.product===product; });
        if(existingProduct){ if(existingProduct.zones.indexOf(name)<0) existingProduct.zones.push(name); }
        else { zoneRowData.push({product:product, zones:[name]}); }
      });
    }
    // Build zone rows HTML grouped by product
    zoneRowData.forEach(function(r){
      zoneRows += '<tr>'
        + '<td style="padding:3pt 5pt;border:0.75pt solid #c8cdd8;font-size:8pt;font-weight:700;">' + r.product + '</td>'
        + '<td style="padding:3pt 5pt;border:0.75pt solid #c8cdd8;font-size:8pt;">' + r.zones.join(', ') + '</td>'
        + '</tr>';
    });
    const zoneCount = fd.zones ? fd.zones.filter(z => z.product && parseFloat(z.rate||0)>0).length : 0;
    // Compress page 1 when many zones fill the page
    const compact = zoneCount >= 6;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Enrollment Agreement - ${record.bizName}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Source+Sans+3:wght@300;400;600;700&family=Dancing+Script:wght@600&display=swap');
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Source+Sans+3:wght@300;400;600;700&display=swap');
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{ font-family:'Source Sans 3',Arial,sans-serif; color:#1a1a2e; font-size:${compact?'7pt':'8pt'}; background:#fff; padding:${compact?'0.22in':'0.35in'}; }
  @page{
    margin:0.35in;
    size:letter portrait;
    /* These suppress headers/footers in Firefox */
    @top-left   { content: ''; }
    @top-center { content: ''; }
    @top-right  { content: ''; }
    @bottom-left   { content: ''; }
    @bottom-center { content: ''; }
    @bottom-right  { content: ''; }
  }
  @media print{
    html, body{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    a{ color:inherit !important; text-decoration:none !important; }
    a[href]:after { content:'' !important; display:none !important; }
    a[href]:before{ content:'' !important; display:none !important; }
  }
  @media screen{
    html{ background:#c8ccd4; }
    body{ max-width:760px; margin:0 auto; padding:20px; background:#fff; box-shadow:0 2px 16px rgba(0,0,0,.18); }
  }
  @media print{
    .print-btn{ display:none !important; }
    html{ background:#fff !important; }
    body{ background:#fff !important; box-shadow:none !important; }
  }
  .page{ page-break-after:always; }
  .page:last-child{ page-break-after:avoid; }
  .hdr{ background:#00205B; padding:${compact?'4pt 10pt':'6pt 12pt'}; border-bottom:3pt solid #BF0D3E; display:flex; align-items:center; justify-content:space-between; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .hdr-title{ color:#fff; font-family:'Playfair Display',serif; font-size:11pt; }
  .hdr-sub{ color:rgba(255,255,255,.7); font-size:7pt; margin-top:1pt; }
  .section{ padding:${compact?'2pt 8pt':'4pt 10pt'}; border-bottom:1pt solid #dde2ef; }
  .sec-title{ background:#00205B; color:#fff; font-size:6.5pt; font-weight:700; letter-spacing:.8pt; text-transform:uppercase; padding:2pt 10pt; margin:0 -10pt 5pt; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .grid2{ display:grid; grid-template-columns:1fr 1fr; gap:4pt; }
  .field label{ display:block; font-size:${compact?'6pt':'6.5pt'}; font-weight:700; color:#4a4f5e; text-transform:uppercase; letter-spacing:.3pt; margin-bottom:${compact?'0':'1pt'}; }
  .field label span{ display:inline-block; border-bottom:0.6pt solid #c8cdd8; padding-bottom:1pt; }
  .field .val{ font-size:${compact?'7pt':'8pt'}; padding:${compact?'0':'1pt 0'}; min-height:${compact?'9pt':'11pt'}; }
  table.dtbl{ width:100%; border-collapse:collapse; margin-bottom:4pt; }
  table.dtbl td{ padding:${compact?'2pt 4pt':'3pt 6pt'}; border:0.75pt solid #c8cdd8; font-size:${compact?'7pt':'8pt'}; }
  table.dtbl td:first-child{ font-weight:700; color:#4a4f5e; background:#edf0f7; width:38%; }
  table.zones{ width:100%; border-collapse:separate; border-spacing:0; font-size:7.5pt; margin-bottom:4pt; border:none; outline:none; }
  table.zones th{ background:transparent; color:#4a4f5e; padding:${compact?'1.5pt 6pt':'2.5pt 8pt'}; font-size:${compact?'6.5pt':'7pt'}; text-align:left; border:none !important; outline:none !important; }
  table.zones th span{ text-decoration:underline; text-underline-offset:2pt; text-decoration-color:#c8cdd8; }
  table.zones td{ padding:${compact?'1.5pt 6pt':'2.5pt 8pt'}; border:none !important; outline:none !important; background:#fff; }
  .totals-box{ border:1.25pt solid #00205B; border-radius:2pt; overflow:hidden; margin:${compact?'2pt 0':'4pt 0'}; }
  .total-row{ display:flex; justify-content:space-between; align-items:center; padding:${compact?'2pt 6pt':'3pt 8pt'}; border-bottom:0.75pt solid #dde2ef; font-size:${compact?'7pt':'8pt'}; }
  .total-row:last-child{ border-bottom:none; }
  .total-row.blue{ background:#00205B; color:#fff; font-weight:700; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .total-row.pink{ background:#fef0f4; font-weight:700; }
  .sig-grid{ display:grid; grid-template-columns:1fr 1fr; gap:${compact?'8pt':'12pt'}; padding:${compact?'3pt 8pt':'5pt 10pt'}; }
  .sig-block label{ font-size:6.5pt; font-weight:700; color:#4a4f5e; text-transform:uppercase; letter-spacing:.3pt; display:block; margin-bottom:3pt; }
  .sig-line{ border-bottom:1.25pt solid #1a1a2e; height:24pt; margin-bottom:2pt; }
  .sig-sub{ font-size:7.5pt; color:#4a4f5e; margin-top:2pt; }
  .ftr{ background:#00205B; border-top:2.5pt solid #BF0D3E; padding:4pt 10pt; display:flex; justify-content:space-between; align-items:center; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .ftr span{ color:rgba(255,255,255,.65); font-size:6.5pt; }
  .conf-bar{ background:#BF0D3E; color:#fff; padding:3pt 6pt; font-size:6.5pt; font-weight:700; text-transform:uppercase; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .esign-bar{ background:#1a5c1a; color:#fff; padding:3pt 6pt; font-size:6.5pt; font-weight:700; text-transform:uppercase; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .print-btn{ position:fixed; top:14px; right:14px; background:#00205B; color:#fff; border:none; padding:9px 18px; border-radius:4px; font-size:12px; font-weight:700; cursor:pointer; font-family:inherit; z-index:999; }
</style>
</head>
<body>
<button class="print-btn" id="print-btn" onclick="doPrint()">&#128438; Print / Save PDF</button>

<!-- PAGE 1 -->
<div class="page">
  <div class="hdr">
    <div><div class="hdr-title">The Texan Local</div><div class="hdr-sub">A Knight Dynamic Solutions, LLC Company</div></div>
    <div style="text-align:right;">
      <div style="color:#fff;font-size:11pt;font-weight:700;">Advertising Enrollment Agreement</div>
      <div class="hdr-sub">${record.signingMethod==='in-person'?'In-Person':'Remote E-Signature'} &bull; Signed: ${signedDateFmt}</div>
    </div>
  </div>

  <!-- CLIENT INFO -->
  <div class="section">
    <div class="sec-title">Client Information</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:${compact?'2pt 12pt':'4pt 16pt'};">
      <div>
        <div class="field"><label><span>Business Name</span></label><div class="val" style="font-size:${compact?'8pt':'9pt'};font-weight:700;">${fd.dba ? (fd.bizName||'')+' dba '+fd.dba : (fd.bizName||'')}</div></div>
        <div class="field" style="margin-top:8pt;"><label><span>Address</span></label><div class="val">${fd.addr||''}</div></div>
        ${fd.city ? `<div class="field"><div class="val">${fd.city||''}, ${fd.state||''} ${fd.zip||''}</div></div>` : ''}
      </div>
      <div>
        <div class="field"><label><span>Contact Name</span></label><div class="val">${fd.contact||''}</div></div>
        <div class="field"><label><span>Phone</span></label><div class="val">${fd.phone||''}</div></div>
        <div class="field"><label><span>Cell</span></label><div class="val">${fd.cell||''}</div></div>
        <div class="field"><label><span>Email</span></label><div class="val">${record.clientEmail||''}</div></div>
      </div>
    </div>
  </div>

  <!-- ENROLLMENT SUMMARY -->
  <div class="section">
    <div class="sec-title">Enrollment Summary</div>
    <div style="margin-bottom:${compact?'3pt':'5pt'};">
      ${(function(){
        var tv=(fd.term||'').toString().trim();
        var tm={'6':'Limited','6 months':'Limited','12':'Premium','12 months':'Premium','24':'Elite','24 months':'Elite'};
        var mo={'6':'6 mo','6 months':'6 mo','12':'12 mo','12 months':'12 mo','24':'24 mo','24 months':'24 mo'};
        var nm=tm[tv]||tv; var ms=mo[tv]||'';
        return '<span style="display:inline-flex;align-items:center;gap:4pt;padding:2pt 10pt;border:1.25pt solid #00205B;border-radius:3pt;background:#edf0f7;">'
          +'<span style="font-size:${compact?\'9pt\':\'10pt\'};font-weight:700;color:#00205B;">'+nm+'</span>'
          +(ms?'<span style="font-size:${compact?\'7pt\':\'8pt\'};color:#4a4f5e;margin-left:3pt;">'+ms+'</span>':'')
          +'</span>';
      })()}
    </div>
    ${zoneRows ? `<table class="zones"><thead><tr><th><span>Product</span></th><th><span>Zones</span></th></tr></thead><tbody>${zoneRows}</tbody></table>` : '<p style="font-size:8.5pt;color:#888;margin-bottom:5pt;">Zone details on file.</p>'}
    ${fd.notes ? `<div style="font-size:8.5pt;margin-top:3pt;"><strong>Notes:</strong> ${fd.notes}</div>` : ''}
  </div>

  <!-- AD APPROVALS -->
  <div class="section">
    <div class="sec-title">Ad Approvals</div>
    <p style="font-size:${compact?'7pt':'8pt'};line-height:1.55;color:#333;margin-bottom:${compact?'2pt':'4pt'};">You will receive timely proofs for your ad placement. To meet our press deadlines, advertisers are bound by the <strong>&ldquo;ad approval process and terms&rdquo;</strong> and must comply with timely approval of ads. Full payment is due with or without an ad approval.</p>
    <div style="font-size:${compact?'7pt':'8pt'};color:#666;margin-top:4pt;display:flex;align-items:center;gap:8pt;">
      <span style="font-weight:700;">Initials:</span>
      ${initSig(initObj.adApproval)}
    </div>
  </div>

  <!-- PAYMENT AUTHORIZATION -->
  <div class="section">
    <div class="sec-title">Payment Authorization</div>
    <div class="conf-bar" style="border-radius:2pt 2pt 0 0;margin-bottom:0;">Payment Method: ${pay.method}</div>
    <table class="dtbl" style="margin-top:0;border-top:none;">
      ${pay.rows}
    </table>
    <div style="font-size:${compact?'7pt':'8pt'};color:#666;margin-top:${compact?'2pt':'3pt'};display:flex;align-items:center;justify-content:space-between;">
      <div>
        <div>${s.payMethod&&s.payMethod.includes('Credit')?'A 4% service fee applies to all credit card payments.':'Client authorizes electronic debits on or about the 20th of each month.'}</div>
        <div style="margin-top:2pt;">Unpaid balance (Including declined CC) to Knight Dynamic Solutions for any reason will incur a fee of the greater of $50 or 10% /Month.</div>
        <div style="margin-top:4pt;display:flex;align-items:center;gap:8pt;font-size:${compact?'7pt':'8pt'};">
          <span style="font-weight:700;">Initials:</span>
          ${initSig(initObj.payment)}
        </div>
      </div>

    </div>
  </div>

  <!-- PAYMENT SUMMARY -->
  <div class="section">
    <div class="sec-title">Payment Summary</div>
    <div class="totals-box">
      <div class="total-row"><span>Subtotal (Monthly Zones)</span><span>${s.subtotal||'$0.00'}</span></div>
      ${s.monthly && s.subtotal && s.monthly !== s.subtotal ? `<div class="total-row"><span>Add-Ons</span><span>${s.monthly}</span></div>` : ''}
      <div class="total-row pink"><span style="font-size:10pt;">First Month Payment</span><span style="font-size:12pt;color:#BF0D3E;">${s.firstMonth||'$0.00'}</span></div>
      <div class="total-row blue"><span style="font-size:10pt;">Monthly Charge (recurring)</span><span style="font-size:12pt;">${s.monthly||'$0.00'}</span></div>
    </div>
    <div style="margin-top:4pt;display:flex;align-items:center;gap:8pt;font-size:${compact?'7pt':'8pt'};">
      <span style="font-weight:700;">Initials:</span>
      ${initSig(initObj.auth)}
    </div>
  </div>

  <div class="ftr">
    <span>The Texan Local &mdash; Knight Dynamic Solutions, LLC</span>
    <span>Page 1 of 2 &bull; Terms &amp; Conditions on reverse</span>
  </div>
</div>

<!-- PAGE 2 -->
<div class="page">
  <div class="hdr">
    <div><div class="hdr-title">The Texan Local</div><div class="hdr-sub">A Knight Dynamic Solutions, LLC Company</div></div>
    <div style="text-align:right;"><div style="color:#fff;font-size:11pt;font-weight:700;">Terms &amp; Conditions</div><div class="hdr-sub">Advertising Enrollment Agreement</div></div>
  </div>

  <!-- FULL T&C -->
  <div class="section" style="padding:6pt 13pt;">
    <div class="sec-title">Terms &amp; Conditions</div>
    <p style="font-size:7.5pt;line-height:1.5;margin-bottom:4pt;text-align:justify;">This Texan Local Advertising Enrollment Agreement (&ldquo;Agreement&rdquo;) is entered into by and between Knight Dynamic Solutions, LLC d/b/a Texan Local (&ldquo;Company&rdquo;) and the business identified in this Agreement (&ldquo;Client&rdquo;). In consideration of the fees set forth herein, Company shall provide advertising placement and related marketing services selected by Client within Texan Local publications and associated distribution channels. Distribution quantities, publication dates, placement positions, and circulation figures are estimates and targets only and may vary from time to time based upon operational, printing, mailing, market, or business considerations. Client acknowledges that Company makes no guarantee regarding leads, sales, revenue, customer acquisition, return on investment, or advertising performance.</p>
    <p style="font-size:7.5pt;line-height:1.5;margin-bottom:4pt;text-align:justify;">Client agrees to the pricing, products, zones, and term selected in this Agreement and acknowledges that it is entering into a fixed-term advertising commitment. All invoices shall be due and payable when billed. Client authorizes Knight Dynamic Solutions, LLC to charge any credit card, debit card, ACH account, checking account, or other payment method provided by Client for all amounts due, including recurring monthly charges, setup fees, renewal terms, late fees, and any authorized additional services. Monthly invoices shall be charged on or about the twentieth (20th) day of each month, or the preceding business day if the twentieth falls on a weekend or holiday. This authorization shall remain in effect throughout the initial term, any renewal term, and until all amounts owed have been paid in full. Any invoice not paid within thirty (30) days shall incur a late fee of $50.00 per month. Client shall not withhold, offset, reduce, dispute, or delay payment based upon advertising performance, lead volume, response rates, ad approval delays, or perceived return on investment. Full payment remains due regardless of whether Client utilizes all advertising opportunities available under this Agreement.</p>
    <p style="font-size:7.5pt;line-height:1.5;margin-bottom:4pt;text-align:justify;">This Agreement shall automatically renew for an additional term equal to the original contract term, with the same products, zones, and pricing, unless either party provides written notice of non-renewal at least sixty (60) days prior to expiration. Company will make reasonable efforts to replicate premium placements during renewal terms when available; however, exact placement dates and positions are not guaranteed. Client may cancel only by providing written notice at least thirty (30) days prior to the next scheduled ad approval deadline. Early termination fee equals fifty percent (50%) of the remaining contract value, together with any outstanding balances then due. All such amounts shall become immediately due and payable upon notice of cancellation.</p>
    <p style="font-size:7.5pt;line-height:1.5;margin-bottom:4pt;text-align:justify;">In the event of nonpayment, chargeback, returned payment, breach, or other default, Company may immediately suspend all services without further notice. Such suspension shall not relieve Client of any payment obligations. Upon default, all unpaid amounts, termination fees, and charges shall immediately become due and payable. In the event of a chargeback, payment dispute, returned ACH, insufficient funds, revoked payment authorization, or other payment reversal initiated by Client, such action constitutes a default and all recovery costs shall be immediately due and payable by Client.</p>
    <p style="font-size:7.5pt;line-height:1.5;margin-bottom:4pt;text-align:justify;">Client shall receive reasonable opportunities to review and approve advertising materials prior to publication. If Client fails to provide approvals, revisions, artwork, or required materials by Company&rsquo;s stated deadlines, Company may publish the most recently approved version, utilize materials previously supplied, or omit the advertisement without relieving Client of any payment obligations. The individual signing personally, unconditionally, and irrevocably guarantees payment and performance of all obligations. Client and guarantor agree to reimburse Company for all enforcement costs including reasonable attorney&rsquo;s fees, court costs, filing fees, collection agency fees, and other collection-related expenses.</p>
    <p style="font-size:7.5pt;line-height:1.5;text-align:justify;">This Agreement constitutes the entire agreement between the parties. Electronic signatures shall be deemed original signatures and shall be fully binding and enforceable under the federal ESIGN Act and UETA. Company shall not be liable for delays caused by events beyond its reasonable control. This Agreement shall be governed by the laws of the State of Texas; exclusive venue for any dispute shall be the state courts located in Comal County, Texas. The prevailing party in any action arising from this Agreement shall be entitled to recover its reasonable attorney&rsquo;s fees and costs.</p>
    <div style="margin-top:6pt;display:flex;align-items:center;gap:8pt;padding:4pt 0;border-top:0.75pt solid #dde2ef;font-size:${compact?'7pt':'8pt'};">
      <span style="font-weight:700;">Initials:</span>
      ${initSig(initObj.tc)}
    </div>
  </div>

  <!-- ESIGN -->
  <div style="padding:0 13pt 5pt;">
    <div class="esign-bar" style="border-radius:2pt 2pt 0 0;">ESIGN / UETA Compliance Record</div>
    <table class="dtbl" style="margin-top:0;">
      <tr><td>Consent</td><td style="font-size:7.5pt;">${s.consentText||'I agree to conduct this transaction using electronic records and signatures.'}</td></tr>
      <tr><td>Consent Given</td><td>${new Date(s.consentAt||record.signedAt).toLocaleString("en-US",{timeZone:"America/Chicago",dateStyle:"full",timeStyle:"short"})}</td></tr>
      ${record.verifiedAt ? `<tr><td>Email Verified</td><td>${new Date(record.verifiedAt).toLocaleString("en-US",{timeZone:"America/Chicago",dateStyle:"full",timeStyle:"short"})}</td></tr>` : ''}
      <tr><td>IP Address</td><td style="font-family:monospace;font-size:8pt;">${s.ipAddress||'In-Person'}</td></tr>
      <tr><td>Audit Hash</td><td style="font-family:monospace;font-size:7.5pt;word-break:break-all;">${record.auditHash||''}</td></tr>
    </table>
  </div>

  <!-- SIGNATURES -->
  <div class="sig-grid" style="padding:4pt 10pt;">
    <div>
      <div class="sig-block">
        <label>Authorized Agent Signature</label>
        <div style="min-height:36pt;border-bottom:1.25pt solid #1a1a2e;margin-bottom:3pt;overflow:hidden;">
          ${s.sigImage ? '<img src="' + s.sigImage + '" style="max-height:36pt;max-width:100%;object-fit:contain;object-position:left bottom;" />' : '<span style="font-family:\'Dancing Script\',cursive;font-size:22pt;color:#00205B;line-height:1;">' + (s.sigName||'') + '</span>'}
        </div>
        <div class="sig-sub">Print Name: <strong>${s.sigName||''}</strong></div>
        <div class="sig-sub">Title: ${s.sigTitle||''}</div>
        <div class="sig-sub">Date: ${s.signedDate||''}</div>

      </div>
    </div>
    <div>
      <div class="sig-block">
        <label>Texan Local Representative</label>
        <div style="min-height:36pt;border-bottom:1.25pt solid #1a1a2e;margin-bottom:3pt;overflow:hidden;">
          ${(record.repSig && record.repSig.image) ? '<img src="'+record.repSig.image+'" style="max-height:36pt;max-width:100%;object-fit:contain;object-position:left bottom;" />' : '<span style="font-family:\'Dancing Script\',cursive;font-size:22pt;color:#00205B;line-height:1;">' + (record.repSig ? record.repSig.name : (s.repSigName||'Josh Knight')) + '</span>'}
        </div>
        <div class="sig-sub">Print Name: <strong>${record.repSig ? record.repSig.name : (s.repSigName||'Josh Knight')}</strong></div>
        <div class="sig-sub">Title: ${record.repSig ? record.repSig.title : (s.repSigTitle||'Owner')} &mdash; Knight Dynamic Solutions, LLC</div>
        <div class="sig-sub">Date: ${record.countersignedAt ? new Date(record.countersignedAt).toLocaleDateString('en-US') : (s.signedDate||'')}</div>
      </div>
    </div>
  </div>

  <div class="ftr">
    <span>The Texan Local &mdash; Knight Dynamic Solutions, LLC</span>
    <span>Page 2 of 2 &bull; Governed by Texas Law &bull; Venue: Comal County, TX</span>
  </div>
</div>

<script>
window.addEventListener('load', function(){
  // Force title to just the business name (no URL pattern) so browser header shows it cleanly
  // The URL in print headers comes from the browser — we open a blob: URL to suppress it
  document.title = 'Enrollment Agreement';
});

function doPrint(){
  // Hide print button before capture
  var btn = document.getElementById('print-btn');
  if(btn) btn.style.display='none';

  // Serialize current page HTML
  var html = '<!DOCTYPE html>' + document.documentElement.outerHTML;

  // Create a blob URL — blob: URLs show as blank in Chrome/Firefox print headers
  var blob = new Blob([html], {type:'text/html'});
  var url  = URL.createObjectURL(blob);

  // Open in a hidden iframe and print from there
  var iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;';
  document.body.appendChild(iframe);

  iframe.onload = function(){
    // Give fonts a moment to load
    setTimeout(function(){
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch(e){
        // Fallback: direct print
        window.print();
      }
      // Restore button and cleanup after a delay
      setTimeout(function(){
        if(btn) btn.style.display='';
        document.body.removeChild(iframe);
        URL.revokeObjectURL(url);
      }, 3000);
    }, 800);
  };

  iframe.src = url;
}
</script>
</body>
</html>`;

    context.res = {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: html
    };
  } catch (err) {
    context.log.error("getPdf error:", err);
    context.res = { status:500, body:{ error:err.message } };
  }
};
