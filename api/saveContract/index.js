// api/saveContract/index.js
// Saves a contract and generates monthly booking slots
const { BlobServiceClient } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER    = 'portal-data';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

// Products that generate special combo months
// Combo A: 12mo → 11 FP + 1 FC+CenterSpread; 24mo → 22 FP + 2 FC+CenterSpread
// Combo B: 6mo → 5 FP + 1 FC+CenterSpread

function expandToBookings(contract) {
  const bookings = [];
  const termMonths = parseInt(contract.term) || 12;
  const signedDate = new Date(contract.signedDate || Date.now());

  contract.zones.forEach(function(zone) {
    if (!zone.product || !zone.startMonth || !zone.rate) return;

    const [startYear, startMo] = zone.startMonth.split('-').map(Number);
    const rate   = parseFloat(zone.rate) || 0;
    const isComboA = zone.product === 'Combo A';
    const isComboB = zone.product === 'Combo B';
    const isCombo  = isComboA || isComboB;

    // Determine how many combo months (FC+CenterSpread) vs regular months
    let totalMonths = termMonths;
    let comboCount  = 0;
    if (isComboA && termMonths === 12)  { comboCount = 1; }
    if (isComboA && termMonths === 24)  { comboCount = 2; }
    if (isComboB && termMonths === 6)   { comboCount = 1; }

    // Default combo month = last month of term (can be overridden)
    const comboMonthIndices = [];
    if (comboCount === 1) comboMonthIndices.push(totalMonths - 1);      // last month
    if (comboCount === 2) { comboMonthIndices.push(11); comboMonthIndices.push(23); } // months 12 and 24

    for (let i = 0; i < totalMonths; i++) {
      const d = new Date(startYear, startMo - 1 + i, 1);
      const year  = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const isComboMonth = comboMonthIndices.includes(i);

      bookings.push({
        bookingId:    uuidv4(),
        contractId:   contract.contractId,
        business:     contract.business,
        zone:         zone.zoneName,
        product:      isComboMonth ? 'FC + Center Spread (Combo Month)' : (isCombo ? zone.product.replace('Combo A','Full Page').replace('Combo B','Full Page') : zone.product),
        baseProduct:  zone.product,
        monthYear:    year + '-' + month,
        year:         String(year),
        month:        month,
        rate:         rate,
        isComboMonth: isComboMonth,
        termIndex:    i + 1,       // which month of the term (1-based)
        totalTermMonths: totalMonths,
        status:       'booked',    // booked, artwork_received, approved, printed, cancelled
        artworkFile:  null,
        notes:        ''
      });
    }
  });
  return bookings;
}

async function loadContainer(blobSvc) {
  const c = blobSvc.getContainerClient(CONTAINER);
  await c.createIfNotExists();
  return c;
}

module.exports = async function(context, req) {
  if (req.method === 'OPTIONS') { context.res={status:200,headers:CORS,body:'{}'}; context.done(); return; }

  try {
    const body = req.body || {};
    const {
      business, contact, email, phone, addr, city, state, zip,
      term, zones, signedDate, firstMonth, monthly, subtotal,
      notes, rep, source, contractId: existingId
    } = body;

    if (!business || !term || !zones || !zones.length) {
      context.res={status:400,headers:CORS,body:JSON.stringify({error:'Missing required fields: business, term, zones'})}; context.done(); return;
    }

    const contractId = existingId || uuidv4();
    const now = new Date().toISOString();
    const contract = {
      contractId,
      business:    business.trim(),
      contact:     contact || '',
      email:       email   || '',
      phone:       phone   || '',
      addr:        addr    || '',
      city:        city    || '',
      state:       state   || '',
      zip:         zip     || '',
      term:        String(term).replace(' months',''),
      zones:       zones,
      signedDate:  signedDate || now.split('T')[0],
      firstMonth:  firstMonth || '',
      monthly:     monthly    || '',
      subtotal:    subtotal   || '',
      notes:       notes  || '',
      rep:         rep    || '',
      source:      source || 'manual',  // 'enrollment' or 'manual'
      createdAt:   now,
      status:      'active'  // active, completed, cancelled
    };

    const blobSvc  = BlobServiceClient.fromConnectionString(STORAGE_CONN);
    const container = await loadContainer(blobSvc);

    // Save contract
    const contractBuf = Buffer.from(JSON.stringify(contract));
    await container.getBlockBlobClient('contracts/' + contractId + '.json')
      .upload(contractBuf, contractBuf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });

    // Generate and save booking slots
    const bookings = expandToBookings(contract);
    for (const b of bookings) {
      const buf = Buffer.from(JSON.stringify(b));
      await container.getBlockBlobClient('bookings/' + b.bookingId + '.json')
        .upload(buf, buf.length, { overwrite:true, blobHTTPHeaders:{blobContentType:'application/json'} });
    }

    context.log('Saved contract', contractId, 'with', bookings.length, 'booking slots');
    context.res = { status:200, headers:CORS, body: JSON.stringify({ ok:true, contractId, bookingsCreated: bookings.length }) };
  } catch(e) {
    context.log.error('saveContract error:', e.message);
    context.res = { status:500, headers:CORS, body: JSON.stringify({ error: e.message }) };
  }
  context.done();
};
