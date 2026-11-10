// web/routes/legal.js — Public Privacy Policy (/privacy) and Terms of Service (/terms), Arabic or English (?lang=en).
// Both pages have the same language switch. Static text only: no data is read.
"use strict";

const { BRAND } = require("../../domain/brand");
const { securityHeaders } = require("../security");
const { html, layout } = require("../html");

const CONTACT = "wehdat.hub@gmail.com";
const T = (lang, pair) => pair[lang === "en" ? 1 : 0];

const TERMS = {
  path: "/terms",
  title: ["شروط الخدمة", "Terms of Service"],
  updated: ["آخر تحديث: ١٠ نوفمبر ٢٠٢٦", "Last updated: 10 November 2026"],
  sections: [
    {
      h: ["١. قبول الشروط", "1. Acceptance of Terms"],
      ar: ["إنشاء حساب أو تسجيل الدخول أو استخدام تطبيق «وحدات هَب» (Wehdat Hub)، سواء عبر تطبيق الهاتف أو لوحة التحكم أو البوتات المرتبطة (مجتمعةً «المنصة»)، يعني موافقتك على هذه الشروط. إذا كنت تسجل نيابةً عن شركة عقارية أو وساطة أو جهة اعتبارية («الشركة»)، فإنك تُقر بأن لديك الصلاحية القانونية لإلزامها بهذه الشروط."],
      en: ["By creating an account, accessing, or using the Wehdat Hub mobile application, web dashboard, or linked bots (together, the \"Platform\"), you agree to these Terms. If you register on behalf of a real estate agency, brokerage or other entity (the \"Agency\"), you confirm that you have the legal authority to bind the Agency to these Terms."]
    },
    {
      h: ["٢. طبيعة الخدمة وإخلاء المسؤولية", "2. Description of the Service and Disclaimer"],
      ar: ["تقدم «وحدات هَب» برمجيات للشركات العقارية لإدارة مخزون الوحدات، وإدارة علاقات العملاء (CRM)، ومتابعة مراحل الصفقات، وأتمتة الرسائل.", "«وحدات هَب» منصة تقنية فقط. ليست وسيطًا عقاريًا مرخصًا، ولا جهة تقييم أو ضمان، ولا طرفًا في أي صفقة عقارية. لا تتحقق المنصة من صحة أي عقار أو سعر أو ملكية أو اتفاق عمولة يتم عبرها، ولا تضمنها."],
      en: ["Wehdat Hub provides business software for real estate agencies to manage unit inventory, customer relationships (CRM), deal stages and message automation.", "Wehdat Hub is a technology provider only. It is not a licensed real estate broker, appraiser, escrow agent or party to any property transaction. It does not inspect, verify or guarantee any listing, price, ownership claim or commission agreement made through the Platform."]
    },
    {
      h: ["٣. الحسابات والأمان", "3. Accounts and Security"],
      ar: ["التسجيل: يجب تقديم بيانات صحيحة ومحدثة عن الشركة وأرقام التواصل والمسؤولين.", "مسؤولية الحساب: تتحمل الشركة مسؤولية كل ما يتم عبر حسابات فريقها (المالك، المديرين، الوسطاء).", "الاستخدام المصرح به: يُحظر مشاركة بيانات الدخول مع أطراف خارج الفريق، أو تجاوز صلاحيات الحساب."],
      en: ["Registration: you must provide accurate, current and complete details about the Agency, contact numbers and administrators.", "Account responsibility: each Agency is responsible for all activity under its staff accounts (owners, managers, brokers).", "Authorised use: sharing sign-in details outside the authorised team, or bypassing access permissions, is prohibited."]
    },
    {
      h: ["٤. الوحدات ومحتوى الشركة", "4. Listings and Agency Content"],
      ar: ["ملكية المحتوى: تحتفظ الشركة بملكيتها الكاملة لمخزون الوحدات وقوائم العملاء وأرقام التواصل والصور وملاحظات الصفقات المرفوعة على المنصة («محتوى الشركة»).", "صحة المحتوى: الشركة وحدها مسؤولة عن التحقق من صحة الوحدات والأسعار وأرقام الملاك، وعن امتلاكها الحق في عرضها.", "سرية العملاء: تعامل «وحدات هَب» محتوى الشركة كبيانات سرية، ولا تبيع قوائم العملاء المحتملين ولا تشاركها مع مكاتب منافسة أو جهات غير مصرح لها."],
      en: ["Content ownership: the Agency keeps full ownership of its unit inventory, client lists, phone numbers, photos and deal notes uploaded to the Platform (\"Agency Content\").", "Content accuracy: the Agency alone is responsible for verifying the accuracy and legal right to market every unit, price and owner contact it uploads.", "Client confidentiality: Wehdat Hub treats Agency Content as confidential and will not sell or disclose lead lists to competing brokerages or unauthorised third parties."]
    },
    {
      h: ["٥. قنوات الرسائل الخارجية", "5. Third-Party Messaging Channels"],
      ar: ["تتيح المنصة الربط مع خدمات طرف ثالث مثل Meta (واتساب للأعمال) وتيليجرام.", "يجب أن تلتزم الشركة بقوانين مكافحة الرسائل المزعجة وشروط الخدمة الخاصة بتلك الجهات. لا يجوز إرسال رسائل ترويجية غير مطلوبة، أو محتوى مسيء، أو رسائل غير قانونية.", "لا تتحمل «وحدات هَب» مسؤولية أي حظر أو قيود أو عقوبات تفرضها Meta أو تيليجرام أو غيرهما على الشركة بسبب طريقة استخدامها لهذه القنوات."],
      en: ["The Platform integrates with third-party services including Meta (WhatsApp Cloud API) and Telegram.", "The Agency must comply with anti-spam laws and those providers' terms. It may not send unsolicited marketing, abusive content or illegal messages.", "Wehdat Hub is not liable for blocks, bans, rate limits or penalties imposed on the Agency by Meta, Telegram or other providers because of how the Agency uses those channels."]
    },
    {
      h: ["٦. الاشتراكات والفوترة", "6. Subscriptions and Billing"],
      ar: ["تخضع الاستخدامات التجارية لرسوم الاشتراك المتفق عليها حسب الباقة المختارة.", "تتجدد الاشتراكات تلقائيًا ما لم يتم إلغاؤها قبل موعد التجديد. قد يؤدي عدم سداد الرسوم المستحقة إلى تعليق الوصول إلى البيانات."],
      en: ["Commercial use is subject to the subscription fees agreed for the chosen plan.", "Subscriptions renew automatically unless cancelled before the renewal date. Unpaid fees may lead to suspension of access to the data."]
    },
    {
      h: ["٧. الملكية الفكرية", "7. Intellectual Property"],
      ar: ["كل حقوق الملكية والعلامات التجارية والبرمجيات وتصميم الواجهات والخوارزميات والشعارات الخاصة بـ«وحدات هَب» ملك حصري لها. يُمنح المستخدم ترخيصًا محدودًا وقابلًا للإلغاء وغير حصري لاستخدام المنصة في العمليات الداخلية للشركة فقط."],
      en: ["All rights in Wehdat Hub's trademarks, software, interface designs, algorithms and logos belong exclusively to Wehdat Hub. Users receive a limited, revocable, non-exclusive licence to use the Platform for the Agency's internal business only."]
    },
    {
      h: ["٨. توافر الخدمة وحدود المسؤولية", "8. Service Availability and Limitation of Liability"],
      ar: ["تُقدم المنصة «كما هي» و«حسب التوافر»، دون ضمان لعدم انقطاع الخدمة أو خلوها من الأخطاء.", "إلى أقصى حد يسمح به القانون، لا تتحمل «وحدات هَب» أي أضرار غير مباشرة أو تبعية، بما في ذلك فوات الأرباح أو الصفقات أو فقد البيانات."],
      en: ["The Platform is provided \"as is\" and \"as available\", without warranty of uninterrupted service or error-free operation.", "To the maximum extent permitted by law, Wehdat Hub is not liable for indirect, incidental or consequential damages, including lost profits, unfinished deals or data loss."]
    },
    {
      h: ["٩. إنهاء الاستخدام", "9. Termination"],
      ar: ["يحق لـ«وحدات هَب» تعليق أو إغلاق أي حساب ينتهك هذه الشروط، أو يكشط البيانات، أو يحاول اختراق الأنظمة، أو لا يسدد الرسوم المستحقة. عند الإنهاء، يحق للشركة طلب تصدير بياناتها وفق سياسة الخصوصية."],
      en: ["Wehdat Hub may suspend or close any account that breaches these Terms, scrapes data, attempts to breach the systems, or does not pay fees due. On termination, the Agency may request an export of its data as described in the Privacy Policy."]
    },
    {
      h: ["١٠. القانون والاختصاص القضائي", "10. Governing Law and Jurisdiction"],
      ar: ["تخضع هذه الشروط وتُفسَّر وفقًا لقوانين جمهورية مصر العربية، وتختص المحاكم المصرية في القاهرة وحدها بأي نزاع ينشأ عنها."],
      en: ["These Terms are governed by the laws of the Arab Republic of Egypt. The competent courts of Cairo have exclusive jurisdiction over any dispute arising from them."]
    },
    {
      h: ["١١. التواصل", "11. Contact"],
      ar: ["للاستفسارات القانونية والتعاقدية وإشعارات الخدمة: " + CONTACT + "."],
      en: ["For legal questions, contract clarifications and service notices: " + CONTACT + "."]
    }
  ]
};

const PRIVACY = {
  path: "/privacy",
  title: ["سياسة الخصوصية", "Privacy Policy"],
  updated: ["تاريخ السريان: ١٠ نوفمبر ٢٠٢٦", "Effective date: 10 November 2026"],
  sections: [
    {
      h: ["١. المقدمة ونطاق التطبيق", "1. Introduction and Scope"],
      ar: ["«وحدات هَب» منصة سحابية لإدارة علاقات العملاء وإدارة مخزون الوحدات وأدوات الأتمتة للشركات والوسطاء العقاريين في مصر.", "توضح هذه السياسة كيف نجمع البيانات ونعالجها ونحميها عند استخدام تطبيق الهاتف ولوحة التحكم وبوتات تيليجرام المرتبطة («المنصة»)."],
      en: ["Wehdat Hub is a cloud CRM, unit inventory and automation platform for real estate agencies, brokers and consultants in Egypt.", "This Privacy Policy explains how we collect, process and protect information when you use the mobile app, the web dashboard and the linked Telegram bots (together, the \"Platform\")."]
    },
    {
      h: ["٢. المتحكم والمعالج", "2. Controller and Processor"],
      ar: ["«وحدات هَب» متحكم في بيانات الحسابات المسجلة للمستخدمين (الوسطاء، المديرين، مسؤولي الشركات) لإدارة الاشتراكات والحماية وتقديم الدعم.", "عندما ترفع الشركة بيانات العملاء وأرقام المشترين المحتملين وتفاصيل الوحدات وأرقام الملاك («محتوى الشركة»)، تكون الشركة هي المتحكم في هذه البيانات، و«وحدات هَب» تعالجها وفق تعليماتها فقط. الشركة مسؤولة عن الحصول على الموافقات اللازمة من الملاك والعملاء."],
      en: ["Wehdat Hub is the controller of the account data of its users (brokers, team leads, agency managers), used to manage subscriptions, keep the Platform secure and provide support.", "When an Agency uploads client records, prospective buyers' details, unit listings and owner contact details (\"Agency Content\"), the Agency is the controller of that data. Wehdat Hub processes it only on the Agency's instructions. The Agency is responsible for obtaining the consents required from owners and clients."]
    },
    {
      h: ["٣. البيانات التي نجمعها", "3. Information We Collect"],
      ar: ["بيانات الحساب: الاسم الكامل، البريد الإلكتروني للعمل، رقم الهاتف، معرّف حساب تيليجرام، الشركة، والدور (مالك، مدير، قائد فريق، وسيط).", "الوحدات والملاك: مواصفات الوحدات والصور وخطط السداد والأسعار وأرقام الملاك التي يدخلها فريق الشركة.", "العملاء وإدارة العلاقات: أسماء المشترين المحتملين وأرقامهم وميزانياتهم ومتطلباتهم وحالة الصفقات، وتأتي عن طريق الإدخال المباشر أو ملفات إكسل وCSV أو تصدير محادثات واتساب أو نماذج إعلانات Meta أو Make.com.", "الرسائل الصوتية والنصوص: الرسائل المرسلة عبر بوت تيليجرام أو التطبيق لتحويلها تلقائيًا إلى بيانات منظمة.", "بيانات الجهاز والتشخيص: طراز الجهاز، وإصدار نظام التشغيل، ورموز الإشعارات (FCM)، وعنوان IP، وتقارير الأعطال.", "الموقع: يُجمع فقط عندما تشاركه بنفسك، مثل تحديد نقطة لقاء أو موقع وحدة على الخريطة. لا نتتبع الموقع في الخلفية."],
      en: ["Account details: full name, work email, phone number, Telegram user ID, agency and role (owner, manager, team lead, broker).", "Units and owners: unit details, photos, payment plans, prices and owner contact details entered by your team.", "Clients and CRM: prospective buyers' names, phone numbers, budgets, requirements and deal stages, entered directly, imported from Excel or CSV files, WhatsApp chat exports, Meta lead forms or Make.com.", "Voice notes and text: messages sent through the Telegram bot or the app, converted automatically into structured records.", "Device and diagnostics: device model, OS version, notification tokens (FCM), IP address and crash reports.", "Location: collected only when you share it yourself, for example to set a meeting point or place a unit on the map. We do not track location in the background."]
    },
    {
      h: ["٤. كيف نستخدم البيانات", "4. How We Use the Data"],
      ar: ["عرض المخزون وتصفيته ومطابقة متطلبات المشترين بالوحدات المتاحة، وتتبع الصفقات.", "معالجة الرسائل والتسجيلات الصوتية وتنظيم بطاقات العملاء والوحدات.", "إرسال الإشعارات الضرورية والتنبيهات الأمنية وتحديثات النظام.", "إدارة الدخول ومراجعة أعمال الفريق حسب الصلاحيات.", "إصلاح الأخطاء ومراقبة الأداء وحماية الأمان.", "لا نبيع البيانات ولا نؤجرها ولا نتاجر بها، ولا نعرض إعلانات موجهة."],
      en: ["Providing inventory filters, matching buyers to available units and tracking deals.", "Processing messages and voice notes and organising client and unit cards.", "Sending essential notifications, security alerts and system updates.", "Managing sign-in and auditing team actions according to role permissions.", "Fixing errors, monitoring performance and keeping the service secure.", "We do not sell, rent or trade personal or property data, and we do not show targeted ads."]
    },
    {
      h: ["٥. الذكاء الاصطناعي", "5. Artificial Intelligence"],
      ar: ["تستخدم المنصة نماذج Google Gemini لتحويل النصوص والرسائل الصوتية إلى بطاقات عملاء ووحدات منظمة.", "تبقى كل بيانات يستخرجها الذكاء الاصطناعي مسودة يراجعها الوسيط ويوافق عليها قبل حفظها نهائيًا."],
      en: ["The Platform uses Google Gemini models to turn text and voice notes into structured client and unit records.", "Everything the AI extracts stays a draft that the broker reviews and approves before it is saved."]
    },
    {
      h: ["٦. مزودو الخدمة", "6. Service Providers"],
      ar: ["نشارك البيانات فقط مع مزودين يشغّلون الخدمة:", "الاستضافة: Render.", "قاعدة البيانات والتخزين: Supabase (PostgreSQL مع صلاحيات على مستوى الصف وتخزين مشفّر).", "الخرائط وتخزين الملفات: Cloudflare R2.", "الرسائل: Telegram Bot API وMeta WhatsApp Cloud API.", "الإشعارات وتقارير الأعطال: Google Firebase (Cloud Messaging وCrashlytics).", "الأتمتة (اختياري): Make.com، فقط إذا فعّلته الشركة.", "الذكاء الاصطناعي: Google Gemini (انظر القسم ٥)."],
      en: ["We share data only with providers that run the service:", "Hosting: Render.", "Database and storage: Supabase (PostgreSQL with row-level security and encrypted storage).", "Map tiles and file storage: Cloudflare R2.", "Messaging: Telegram Bot API and Meta WhatsApp Cloud API.", "Notifications and crash reports: Google Firebase (Cloud Messaging and Crashlytics).", "Automation (optional): Make.com, only if the Agency turns it on.", "AI: Google Gemini (see section 5)."]
    },
    {
      h: ["٧. الأمان ونقل البيانات", "7. Security and Data Location"],
      ar: ["التشفير: نستخدم HTTPS/TLS لكل البيانات المنقولة. لا نحفظ كلمات المرور كنص عادي، ويعتمد الدخول على رموز التحقق لمرة واحدة ومفاتيح المرور الآمنة حيث تكون مفعّلة. أرقام الهواتف المستخدمة للمطابقة تُحفظ كبصمات مشفّرة.", "مكان المعالجة: تُحفظ البيانات وتُعالج لدى مزودي الخدمة المذكورين، وقاعدة البيانات في أوروبا. باستخدامك المنصة، فإنك توافق على نقل البيانات خارج جمهورية مصر العربية بمعايير حماية مناسبة."],
      en: ["Encryption: all data in transit uses HTTPS/TLS. Passwords are never stored in plain text; sign-in relies on one-time codes and passkeys where enabled. Phone numbers used for matching are stored as keyed hashes.", "Where data is processed: data is stored and processed by the providers listed above, and the database is hosted in Europe. By using the Platform you agree that data may be transferred and kept outside the Arab Republic of Egypt under appropriate safeguards."]
    },
    {
      h: ["٨. مدة الاحتفاظ", "8. Retention"],
      ar: ["الحسابات النشطة: تُحفظ البيانات طالما الاشتراك ساريًا.", "سجلات النظام: تُحذف سجلات النشاط وتقارير الأعطال تلقائيًا كل ٩٠ يومًا.", "إغلاق الحساب: عند إنهاء الاشتراك أو طلب الحذف، تُحذف بيانات الحساب ومحتوى الشركة خلال ٣٠ يومًا، إلا ما يفرضه القانون من حفظ للسجلات المالية أو الضريبية."],
      en: ["Active accounts: data is kept while the subscription is active.", "System logs: activity logs and crash reports are deleted automatically after 90 days.", "Closing an account: when the subscription ends or a deletion is requested, account data and Agency Content are deleted within 30 days, except records the law requires us to keep for tax or accounting."]
    },
    {
      h: ["٩. حذف الحساب والبيانات", "9. Deleting Your Account and Data"],
      ar: ["يحق لأي مستخدم أو شركة طلب الحذف النهائي للحساب وكل البيانات المرتبطة به، دون الحاجة إلى فتح التطبيق أو إعادة تثبيته.", "طريقة الطلب: اضغط زر «طلب حذف الحساب» أدناه، أو أرسل بريدًا إلى " + CONTACT + " من البريد المسجل في حسابك، بعنوان «طلب حذف الحساب - وحدات هَب»، واذكر اسمك ورقم الهاتف المسجل واسم الشركة.", "المدة: نتحقق من الطلب ونحذف بيانات الحساب ومعرّفات الأجهزة خلال ٣٠ يومًا، ونؤكد الحذف بالبريد الإلكتروني.", "محتوى الشركة: الوحدات وقوائم العملاء المملوكة للشركة تبقى تحت إدارة مالك الشركة، ولا تُحذف إلا إذا طلب مالك الشركة حذف المؤسسة كاملة."],
      en: ["Any user or agency may request permanent deletion of their account and all personal data linked to it, without needing to open or reinstall the app.", "How to request: tap the \"Request account deletion\" button below, or email " + CONTACT + " from the address on your account with the subject \"Account Deletion Request - Wehdat Hub\", and include your full name, the registered phone number and the agency name.", "Timing: we verify the request and delete the account data and device tokens within 30 days, then confirm by email.", "Agency content: units and client lists owned by the Agency stay under the Agency owner's control, and are removed only if the Agency owner asks for the whole organisation to be deleted."]
    },
    {
      h: ["١٠. حقوقك", "10. Your Rights"],
      ar: ["وفقًا لقانون حماية البيانات الشخصية المصري رقم ١٥١ لسنة ٢٠٢٠، لك الحق في:", "الاطلاع على بياناتك الشخصية والحصول على نسخة منها، وتصحيح البيانات غير الدقيقة، وتصدير بياناتك بصيغة CSV أو JSON، وسحب موافقتك وطلب المحو.", "لممارسة حقوقك أرسل طلبك إلى " + CONTACT + "، ونرد خلال ٣٠ يومًا دون رسوم."],
      en: ["Under Egyptian Personal Data Protection Law No. 151 of 2020, you have the right to:", "see your personal data and get a copy, correct inaccurate data, export your data as CSV or JSON, and withdraw consent and request deletion.", "To exercise these rights, write to " + CONTACT + ". We reply within 30 days at no charge."]
    },
    {
      h: ["١١. الأطفال", "11. Children"],
      ar: ["«وحدات هَب» موجهة للمهنيين من سن ١٨ عامًا فأكثر. لا نجمع عن قصد بيانات من الأطفال."],
      en: ["Wehdat Hub is for professionals aged 18 and over. We do not knowingly collect data from children."]
    },
    {
      h: ["١٢. التعديلات", "12. Changes"],
      ar: ["ننشر أي تعديل في هذه الصفحة مع تحديث تاريخ السريان. للتغييرات الجوهرية نُخطر مديري الشركات بالبريد الإلكتروني أو تنبيه المنصة."],
      en: ["We post any change on this page with an updated effective date. For major changes we notify agency administrators by email or in-app alert."]
    }
  ]
};

const DELETE_SUBJECT = { ar: "طلب حذف الحساب - وحدات هَب", en: "Account Deletion Request - Wehdat Hub" };

function pageBody(doc, lang, other) {
  const base = doc.path;
  const sections = doc.sections.map(
    (s) => html`<section><h2>${T(lang, s.h)}</h2>${(lang === "en" ? s.en : s.ar).map((p) => html`<p>${p}</p>`)}${
      doc === PRIVACY && s === PRIVACY.sections[8]
        ? html`<p><a class="btn" href="mailto:${CONTACT}?subject=${encodeURIComponent(DELETE_SUBJECT[lang])}">✉️ ${T(lang, ["طلب حذف الحساب", "Request account deletion"])}</a></p>`
        : ""
    }</section>`
  );
  return html`<nav class="top lp-top"><span class="brand">${BRAND.name}</span><a class="logout" href="${base}?lang=${other}" data-lang-switch hreflang="${other}">${other === "en" ? "English" : "العربية"}</a><a class="btn small" href="/app/">${T(lang, ["دخول", "Sign in"])}</a></nav>
<article class="card stack privacy">
  <h1>${T(lang, doc.title)}</h1>
  <p class="muted">${T(lang, doc.updated)}</p>
  ${sections}
</article>
<footer class="lp-foot"><span>${BRAND.name}</span><a href="/?lang=${lang}">${T(lang, ["الرئيسية", "Home"])}</a><a href="/privacy?lang=${lang}">${T(lang, ["الخصوصية", "Privacy"])}</a><a href="/terms?lang=${lang}">${T(lang, ["الشروط", "Terms"])}</a><a href="mailto:${CONTACT}">${CONTACT}</a></footer>`;
}

function mountLegal(app, { assets }) {
  const serve = (doc) => (req, res) => {
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
            title: T(lang, doc.title),
            robots: "index, follow",
            scripts: false,
            manifest: false,
            head: html`<link rel="alternate" hreflang="${other}" href="${doc.path}?lang=${other}">`,
            body: pageBody(doc, lang, other)
          })
        )
      );
  };
  app.get("/privacy", securityHeaders, serve(PRIVACY));
  app.get("/terms", securityHeaders, serve(TERMS));
}

module.exports = { mountLegal, PRIVACY, TERMS, CONTACT };
