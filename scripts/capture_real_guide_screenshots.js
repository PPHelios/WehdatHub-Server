const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { getPool } = require('../lib/db');
const WebAuth = require('../lib/webAuth');

const TARGET_DIR = path.join(__dirname, '..', 'web', 'static', 'guide');

async function sanitize(page) {
  await page.evaluate(() => {
    // 1. Text walker for phone numbers and private names
    const phoneRe = /(?:\+?20|0)?1[0125]\d{8}/g;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue) continue;
      node.nodeValue = node.nodeValue.replace(phoneRe, '01012345678');
      node.nodeValue = node.nodeValue
        .replace(/\bMazen Wael\b/gi, 'عميل مهتم')
        .replace(/\bTamer Fathy\b/gi, 'أحمد محمود')
        .replace(/\bDalia Fouad\b/gi, 'سارة علي')
        .replace(/\bOmar Lotfy\b/gi, 'محمد كريم')
        .replace(/\bDina Fawzy\b/gi, 'منى حسن')
        .replace(/\bMarwa Helal\b/gi, 'نور الهدى')
        .replace(/\bOla Mahdy\b/gi, 'ياسمين أحمد')
        .replace(/\bHala Mostafa\b/gi, 'مريم إبراهيم')
        .replace(/\bKarim Adel\b/gi, 'كريم عادل')
        .replace(/\bNour Ibrahim\b/gi, 'عميل محتمل');
    }

    // 2. Sanitize input/textarea values
    const inputs = document.querySelectorAll('input, textarea');
    for (const el of inputs) {
      if (el.value) {
        el.value = el.value.replace(phoneRe, '01012345678');
      }
    }

    // 3. Ensure agency header is clean
    const agencyEls = document.querySelectorAll('.agency-name, [data-agency-name], .brand-sub');
    for (const el of agencyEls) {
      el.textContent = 'Wehdat Hub Agency';
    }
  });
}

(async () => {
  const pool = getPool();
  const { rows } = await pool.query("SELECT * FROM brokers WHERE phone_normalized = '201012345674'");
  const broker = rows[0];

  // Assign test imports to Khaled Samir
  await pool.query("UPDATE web_imports SET broker_id = $1, agency_id = $2 WHERE id IN ('b3533273-ece2-4c06-b5da-b75611665911', '12f7a559-27ed-40f2-bbd2-c8b4f1f9e7d6')", [broker.id, broker.agency_id]);

  const { sid } = await WebAuth.createSession(pool, broker);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1024, height: 740 },
    locale: 'ar-EG',
  });

  await context.addCookies([{
    name: 'aq_sid',
    value: sid,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  }]);

  const page = await context.newPage();

  console.log('Capturing real screenshots from live application...');

  // ==========================================
  // GROUP 1: EXCEL IMPORT
  // ==========================================
  console.log('[1/16] import-excel-01-upload-sheets.png');
  await page.goto('http://localhost:3000/app/import');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'import-excel-01-upload-sheets.png') });

  console.log('[2/16] import-excel-02-mapping-headers.png');
  await page.goto('http://localhost:3000/app/import/b3533273-ece2-4c06-b5da-b75611665911');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'import-excel-02-mapping-headers.png') });

  console.log('[3/16] import-excel-03-diff-preview.png');
  await page.evaluate(() => window.scrollBy(0, 420));
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'import-excel-03-diff-preview.png') });

  console.log('[4/16] import-excel-04-rules-dedup.png');
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'import-excel-04-rules-dedup.png') });

  // ==========================================
  // GROUP 2: WHATSAPP CHAT INTAKE
  // ==========================================
  console.log('[5/16] import-chat-01-upload-filters.png');
  await page.goto('http://localhost:3000/app/import');
  await page.waitForLoadState('networkidle');
  await page.click('label[for="import_tab-2"]');
  await page.waitForTimeout(600);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'import-chat-01-upload-filters.png') });

  console.log('[6/16] import-chat-02-parse-extract.png');
  await page.goto('http://localhost:3000/app/import/12f7a559-27ed-40f2-bbd2-c8b4f1f9e7d6');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'import-chat-02-parse-extract.png') });

  console.log('[7/16] import-chat-03-photos-matching.png');
  await page.evaluate(() => window.scrollBy(0, 400));
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'import-chat-03-photos-matching.png') });

  console.log('[8/16] import-chat-04-conflict-assign.png');
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'import-chat-04-conflict-assign.png') });

  // ==========================================
  // GROUP 3: LEAD INTAKE (BROKER & TEAM LEAD)
  // ==========================================
  console.log('[9/16] lead-intake-01-create-normalize.png');
  await page.goto('http://localhost:3000/app/leads/new');
  await page.waitForLoadState('networkidle');
  await page.fill('textarea[name="message"]', 'طلب شقة للبيع في التجمع الخامس 3 غرف، ميزانية حتى 8 مليون كاش.');
  await page.fill('input[name="name"]', 'أحمد محمود');
  await page.fill('input[name="phone1"]', '01012345678');
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'lead-intake-01-create-normalize.png') });

  console.log('[10/16] lead-intake-02-duplicate-guard.png');
  await page.fill('input[name="phone1"]', '01020010011');
  await page.dispatchEvent('input[name="phone1"]', 'change');
  await page.waitForTimeout(1000);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'lead-intake-02-duplicate-guard.png') });

  console.log('[11/16] lead-intake-03-undo-stack.png');
  await page.goto('http://localhost:3000/app/leads/11');
  await page.waitForLoadState('networkidle');
  // Trigger a stage update to display the undo button
  const csrfInput = await page.$('input[name="_csrf"]');
  if (csrfInput) {
    const csrfVal = await csrfInput.getAttribute('value');
    await page.evaluate(async (csrf) => {
      await fetch('/app/leads/11/stage', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: '_csrf=' + encodeURIComponent(csrf) + '&stage=interested'
      });
    }, csrfVal);
    await page.reload();
    await page.waitForLoadState('networkidle');
  }
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'lead-intake-03-undo-stack.png') });

  console.log('[12/16] lead-intake-04-team-lead-pod.png');
  await page.goto('http://localhost:3000/app/team');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'lead-intake-04-team-lead-pod.png') });

  // ==========================================
  // GROUP 4: LEAD MANAGEMENT (MANAGER)
  // ==========================================
  console.log('[13/16] lead-manager-01-pipeline-board.png');
  await page.goto('http://localhost:3000/app/leads/board');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'lead-manager-01-pipeline-board.png') });

  console.log('[14/16] lead-manager-02-rules-schedule.png');
  await page.goto('http://localhost:3000/app/team?tab=1');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'lead-manager-02-rules-schedule.png') });

  console.log('[15/16] lead-manager-03-broker-away.png');
  await page.goto('http://localhost:3000/app/team');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'lead-manager-03-broker-away.png') });

  console.log('[16/16] lead-manager-04-pdpl-governance.png');
  await page.goto('http://localhost:3000/app/leads/11');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(TARGET_DIR, 'lead-manager-04-pdpl-governance.png') });

  console.log('SUCCESS: All 16 authentic screenshots captured and saved to web/static/guide/!');

  await browser.close();
  await pool.end();
})();
