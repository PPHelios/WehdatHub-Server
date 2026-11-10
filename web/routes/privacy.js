// web/routes/privacy.js — The public privacy policy at /privacy (the store listing URL), Arabic or English (?lang=en),
// with the same language switch as the landing page. Static text only: no data is read.
"use strict";

const { BRAND } = require("../../domain/brand");
const { securityHeaders } = require("../security");
const { html, layout } = require("../html");

const CONTACT = "wehdat.hub@gmail.com";
const T = (lang, pair) => pair[lang === "en" ? 1 : 0];

// Each section: title and paragraphs, in Arabic (ar) and English (en).
const SECTIONS = [
  {
    title: ["من نحن", "Who we are"],
    ar: ["وَذَات هَب أداة لإدارة العملاء والوحدات والمخزون لشركات العقارات والوسطاء في مصر، تعمل على تيليجرام والموقع والتطبيق."],
    en: ["WehdatHub is a CRM and inventory tool for real estate brokers and agencies in Egypt, on Telegram, the web and the mobile app."]
  },
  {
    title: ["تاريخ السريان", "Effective date"],
    ar: ["١٠ نوفمبر ٢٠٢٦"],
    en: ["10 November 2026"]
  },
  {
    title: ["البيانات التي نجمعها", "What we collect"],
    ar: [
      "بيانات الحساب: الاسم، رقم الموبايل، معرّف حساب تيليجرام، الشركة والدور الوظيفي.",
      "بيانات الوحدات والملاك: تفاصيل الوحدة والأسعار والصور وأسماء الملاك وأرقام هواتفهم والملاحظات التي تدخلها الشركة.",
      "بيانات العملاء المحتملين: أسماء العملاء وأرقامهم واحتياجاتهم وحالة كل عميل. تأتي من ملفات ترفعها الشركة (إكسل، CSV، تصدير محادثات واتساب، نماذج إعلانات فيسبوك) أو من رسائل ترسلها أنت.",
      "الرسائل الصوتية والنصوص: الرسائل التي ترسلها إلى البوت أو الموقع أو التطبيق، بما فيها الرسائل الصوتية المحوّلة إلى نص.",
      "الموقع: فقط عندما تشاركه أو تكتب مكانًا. يُستخدم لتحديد مكان اللقاء أو عرض المشاريع على الخريطة. لا نتتبع موقعك في الخلفية.",
      "الصور: الصور التي ترفعها للوحدات أو المشاريع أو المحادثات.",
      "بيانات الجهاز والاستخدام: إصدار التطبيق ونوع الجهاز وتقارير الأخطاء وسجل النشاط للأمان والدعم.",
      "رموز الإشعارات: إذا سمحت بالإشعارات في التطبيق."
    ],
    en: [
      "Account data: name, mobile number, Telegram account ID, agency and role.",
      "Unit and owner data: unit details, prices, photos, owner names and phone numbers, and notes entered by your agency.",
      "Lead data: client names and phone numbers, requirements and the status of each lead. They come from files your agency uploads (Excel, CSV, WhatsApp chat exports, Facebook lead forms) or from messages you send.",
      "Voice notes and text: messages you send to the bot, the website or the app, including voice notes converted to text.",
      "Location: only when you share it or type a place. It sets a meeting place or shows projects on the map. We do not track your location in the background.",
      "Photos: images you upload for units, projects or chats.",
      "Device and usage data: app version, device type, error reports and activity logs, for security and support.",
      "Notification tokens: if you allow notifications in the app."
    ]
  },
  {
    title: ["كيف نستخدمها", "How we use it"],
    ar: ["لتشغيل نظام إدارة العملاء، وربط العملاء بالوحدات، وإرسال التنبيهات التي طلبتها، وتحسين الخدمة، وإصلاح الأخطاء، ومنع إساءة الاستخدام، والرد على طلبات الدعم. لا نبيع البيانات الشخصية ولا نستخدمها في الإعلانات."],
    en: ["To run the CRM, match leads to units, send the alerts you asked for, improve the service, fix errors, prevent misuse and answer support requests. We do not sell personal data and we do not use it for advertising."]
  },
  {
    title: ["المعالجة بالذكاء الاصطناعي", "AI processing"],
    ar: ["تُرسل الرسائل الصوتية وبعض النصوص إلى Google (نماذج Gemini) لتحويلها إلى سجلات منظمة. تراجع أنت النتيجة قبل حفظها أو عرضها على أي عميل."],
    en: ["Voice notes and some text are sent to Google (Gemini models) to turn them into structured records. You review the result before it is saved or shown to a client."]
  },
  {
    title: ["من يتلقى البيانات", "Who receives the data"],
    ar: ["مزودو الخدمة فقط، ليشغّلوا الخدمة وفق شروطهم: Render (الاستضافة)، وSupabase (قاعدة البيانات وتخزين الملفات)، وتيليجرام وMeta WhatsApp Cloud API (إيصال الرسائل)، وGoogle (معالجة Gemini، وFirebase لإشعارات التطبيق وتقارير الأخطاء)، وCloudflare R2 (بلاطات الخريطة)، وMake.com (استقبال العملاء، إذا فعّلته الشركة)."],
    en: ["Service providers only, to run the service under their terms: Render (hosting), Supabase (database and file storage), Telegram and Meta WhatsApp Cloud API (message delivery), Google (Gemini processing, and Firebase for app notifications and crash reports), Cloudflare R2 (map tiles), and Make.com (lead intake, if your agency turns it on)."]
  },
  {
    title: ["بيانات عملائك وملاكك", "Your clients' and owners' data"],
    ar: ["في بيانات العملاء والملاك، الشركة هي المتحكم في البيانات، ووَذَات هَب تعالجها وفق تعليمات الشركة. يجب أن يكون للشركة أساس قانوني، وأن تُعلم عملاءها وملاكها بكيفية استخدام بياناتهم."],
    en: ["For client and owner data, your agency is the data controller and WehdatHub processes it on the agency's instructions. The agency must have a lawful basis and tell its clients and owners how their data is used."]
  },
  {
    title: ["التخزين والأمان", "Storage and security"],
    ar: ["الوصول إلى البيانات محكوم بالأدوار (مالك الشركة، المدير، الوسيط). لا نحتفظ بأي سر دخول بشكل نصي، ويتم الدخول عبر تيليجرام ورموز تُرسل لمرة واحدة، ومفاتيح المرور الآمنة حيث تكون مفعّلة. بعض أرقام الهواتف المستخدمة للمطابقة تُخزن أيضًا كبصمات مشفّرة."],
    en: ["Access is controlled by role (agency owner, manager, broker). No sign-in secret is stored in plain text. Sign-in uses Telegram and one-time codes, and passkeys where enabled. Some phone numbers used for matching are also stored as keyed hashes."]
  },
  {
    title: ["مدة الاحتفاظ", "How long we keep data"],
    ar: ["تُحفظ البيانات ما دام حساب الشركة نشطًا. تُحفظ سجلات النشاط للمدة اللازمة للأمان والدعم ثم تُحذف. عند طلب الحذف (انظر أدناه) نحذف البيانات خلال ٣٠ يومًا، إلا ما يُلزمنا القانون بالاحتفاظ به."],
    en: ["Data is kept while the agency account is active. Activity logs are kept only as long as needed for security and support, then deleted. When you ask for deletion (see below), we delete the data within 30 days, except what the law requires us to keep."]
  },
  {
    title: ["حقوقك وطلب حذف بياناتك", "Your rights and deleting your data"],
    ar: [
      "من حقك طلب الاطلاع على بياناتك الشخصية أو تصحيحها أو تصديرها أو حذفها، وسحب موافقتك. لطلب الحذف، أرسل بريدًا إلى " + CONTACT + " من البريد المرتبط بحسابك، أو اذكر رقم الموبايل المسجل في الحساب. نرد خلال ٣٠ يومًا. ويمكنك أيضًا مراجعة شركتك، لأنها المتحكم في بيانات عملائها.",
    ],
    en: [
      "You can ask to see, correct, export or delete your personal data, and to withdraw consent. To delete your data, email " + CONTACT + " from the email on your account, or give the mobile number on your account. We reply within 30 days. You can also ask your agency, which is the controller for its client data."
    ]
  },
  {
    title: ["الأطفال", "Children"],
    ar: ["وَذَات هَب مخصصة للمستخدمين المهنيين من سن ١٨ عامًا فأكثر. لا نجمع عن قصد بيانات من الأطفال."],
    en: ["WehdatHub is for professional users aged 18 and over. We do not knowingly collect data from children."]
  },
  {
    title: ["التغييرات", "Changes"],
    ar: ["ننشر أي تغيير في هذه الصفحة ونحدّث تاريخ السريان. للتغييرات الجوهرية نُخطر مالكي الشركات."],
    en: ["We will post changes on this page and update the effective date. For major changes we will notify agency owners."]
  },
  {
    title: ["القانون والتواصل", "Law and contact"],
    ar: ["ينطبق قانون حماية البيانات الشخصية المصري رقم ١٥١ لسنة ٢٠٢٠. للأسئلة والطلبات: " + CONTACT + "."],
    en: ["The Egyptian Personal Data Protection Law No. 151 of 2020 applies. Questions and requests: " + CONTACT + "."]
  }
];

function privacyBody(lang, other) {
  return html`<nav class="top lp-top"><span class="brand">${BRAND.name}</span><a class="logout" href="/privacy?lang=${other}" data-lang-switch hreflang="${other}">${other === "en" ? "English" : "العربية"}</a><a class="btn small" href="/app/">${T(lang, ["دخول", "Sign in"])}</a></nav>
<article class="card stack privacy">
  <h1>${T(lang, ["سياسة الخصوصية", "Privacy Policy"])}</h1>
  ${SECTIONS.map(
    (s) => html`<section><h2>${T(lang, s.title)}</h2>${(lang === "en" ? s.en : s.ar).map((p) => html`<p>${p}</p>`)}</section>`
  )}
</article>
<footer class="lp-foot"><span>${BRAND.name}</span><a href="/?lang=${lang}">${T(lang, ["الرئيسية", "Home"])}</a><a href="/app/guide?lang=${lang}">${T(lang, ["الدليل", "Guide"])}</a><a href="mailto:${CONTACT}">${CONTACT}</a></footer>`;
}

function mountPrivacy(app, { assets }) {
  app.get("/privacy", securityHeaders, (req, res) => {
    const lang = req.query.lang === "en" ? "en" : "ar";
    const other = lang === "en" ? "ar" : "en";
    res.set("Cache-Control", "public, max-age=3600");
    return res
      .status(200)
      .type("html")
      .send(
        String(
          layout({
            assets: assets.url,
            lang,
            title: T(lang, ["سياسة الخصوصية", "Privacy Policy"]),
            robots: "index, follow",
            scripts: false,
            manifest: false,
            head: html`<meta name="description" content="${T(lang, ["سياسة خصوصية وَذَات هَب: البيانات التي نجمعها، وكيف نستخدمها، وكيف تطلب الحذف.", "WehdatHub privacy policy: what we collect, how we use it and how to ask for deletion."])}">
<link rel="alternate" hreflang="${other}" href="/privacy?lang=${other}">`,
            body: privacyBody(lang, other)
          })
        )
      );
  });
}

module.exports = { mountPrivacy, SECTIONS, CONTACT };
