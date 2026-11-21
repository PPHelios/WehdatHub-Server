// web/routes/guide.js — The user guide and FAQ: /app/guide, open to everyone (signed in or not, in the
// website and the Telegram Mini App), Arabic or English with the usual ?lang= switch.
// Features 5 comprehensive tabs:
// 1. Telegram Bot & Commands (📱 تيليجرام والأوامر)
// 2. Units & Search (🏠 الوحدات والبحث)
// 3. Excel Import (📊 إكسيل الوحدات)
// 4. WhatsApp Chat Intake (💬 شات واتساب)
// 5. Lead Intake & Management (CRM) (👥 إدارة العملاء)
"use strict";

const { html } = require("../html");
const Words = require("../../domain/commandWords");
const Authz = require("../../lib/authz");
const { tabs } = require("../views/tabs");

const T = (lang, pair) => pair[lang === "en" ? 1 : 0];

const SECTIONS = [
  {
    id: "start",
    title: ["🚀 البداية", "🚀 Getting started"],
    items: [
      ["مديرك يضيفك من «فريقي» ويبعتلك لينك تيليجرام. دوس عليه مرة واحدة وحسابك يتربط بالبوت @Wehdat_Hub_bot.", "Your manager adds you from \"My team\" and sends you a Telegram link. Tap it once and your account is linked to the @Wehdat_Hub_bot bot."],
      ["زرار القائمة في البوت بيفتح الموقع جوه تيليجرام وإنت داخل على طول.", "The menu button in the bot opens the website inside Telegram, already signed in."],
      ["على الكمبيوتر: ابعت «دخول» أو /login للبوت وهيوصلك لينك دخول للموقع.", "On a computer: send \"login\" or /login to the bot and you get a sign-in link for the website."],
      ["ابعت «مساعدة» أو /help في أي وقت عشان تشوف كل الأوامر.", "Send \"help\" or /help any time to see every command."]
    ]
  },
  {
    id: "limits",
    title: ["🚦 الحدود والرصيد", "🚦 Limits and credits"],
    items: [
      ["باقتك ليها رصيد شهري واحد للذكاء الاصطناعي لكل الشركة (طلب نصي ١، فويس ٣، أول فلاير للوحدة ٣، صفحة ملف جديدة ١٠)، وعدد وحدات متاحة، وعدد مستخدمين. لو الرصيد خلص: الإضافة والبحث بيفضلوا شغالين من الموقع. الوحدات المباعة والمؤرشفة مش بتتحسب.", "Your plan has one monthly AI credit pool for the whole agency (text request 1, voice note 3, a unit's first flyer 3, a new document page 10), a number of available units and a number of users. When credits run out, adding and searching on the website still work. Sold and archived units don't count."],
      ["قراية قوايم الأسعار (PDF وصور) بالذكاء الاصطناعي ليها حد صفحات شهري ومقفولة لحد ما صاحب التطبيق يفتحها. الصفحة اللي اتقرت قبل كده ببلاش، وشيت الإكسيل بيتقرا ببلاش.", "AI reading of price lists (PDF and photos) has a monthly page limit and is off until the app owner switches it on. A page read before is free, and an Excel sheet is read free."],
      ["ردود المساعد من الإنترنت اختيارية، ليها حد شهري، ومكتوب عليها غير مؤكد. الرد من بيانات شركتك مش بيتحسب منها.", "Assistant web answers are optional, have a monthly limit and are labelled unverified. Answers from your agency's data don't use it."],
      ["ترتيب الصور بإيدك (سحب وإفلات) بيوفر رصيد الذكاء الاصطناعي. المدير يقفل ترتيب الصور بالذكاء الاصطناعي لكل الشركة من صفحة استخدامي.", "Ordering photos by hand (drag and drop) saves AI credits. A manager can switch AI photo ordering off for the whole agency on My usage."],
      ["المدير يشوف كل الحدود وكام استهلكت من لوحة الشركة، وصفحة الباقة فيها الأسعار والترقية. لو الحد خلص، كل حاجة بتفضل شغالة بإيدك وبياناتك مش بتتمسح.", "Managers see every limit and how much is used on the agency dashboard; the Plan page has prices and upgrades. When a limit is reached everything keeps working by hand and your data is never deleted."]
    ]
  },
  {
    id: "units",
    title: ["🏠 الوحدات", "🏠 Units"],
    items: [
      ["ابعت «إضافة»، بعدين الصور، بعدين فويس أو رسالة بالتفاصيل (الكمبوند، المساحة، السعر، الغرف)، واكتب «تم». البوت يوريك فهم إيه وتأكد.", "Send \"add\", then the photos, then a voice note or a message with the details (compound, area, price, bedrooms), and send \"done\". The bot shows what it understood for you to confirm."],
      ["كل وحدة بتاخد كود قصير زي NH-V12 (حروف الشركة + نوع الوحدة + رقم). ابعت الكود في أي وقت يطلعلك الكارت.", "Every unit gets a short code like NH-V12 (agency letters + unit type + number). Send the code any time to get its card."],
      ["وانت بتضيف وحدة، ابعت جهة اتصال المالك (Share contact) وهتتحط كاسم ورقم المالك في المراجعة، من غير ما يتعمل عميل. المالك بيتسجل كبروفايل مالك لما تحفظ.", "While adding a unit, share the owner's contact: it fills the owner's name and phone on the review, and no lead is created. The owner is saved as an owner profile when you save the unit."],
      ["من الكارت: تعديل، تم البيع، أرشفة، لينك للعميل، بروشور.", "From the card: edit, mark sold, archive, a client link, a flyer."],
      ["لو وحدة متعدلتش ٢١ يوم، البوت يسألك «لسه متاحة؟». لو محدش رد لحد ٣٠ يوم بتتخفى من البحث (مش بتتمسح).", "If a unit hasn't changed for 21 days the bot asks \"still available?\". With no answer by day 30 it is hidden from search (never deleted)."],
      ["التحميل (شيت إكسيل، جروب، أو شات متصدّر بالصور) للمديرين بس، من الموقع: «الوحدات ← تحميل». قبل الحفظ بتشوف كل صف هيعمل إيه. القالب فيه أمثلة، والأعمدة الحمرا مطلوبة والرمادي اختياري.", "Importing (an Excel sheet, a group post, or an exported chat with photos) is for managers only, on the website under Units → Import. You see what every row will do before anything is saved. The template has samples: red columns are mandatory, grey ones optional."],
      ["البيانات الخاصة (المالك، رقم الوحدة، العنوان، اللوكيشن، العمولة) بتظهر للبروكر بتاع الوحدة والمديرين بس. بروكر تاني يضغط «🔒 اطلب البيانات» على نتيجة البحث أو الكارت؛ المدير بيرد، ولو الشركة فتحت البيانات للكل مفيش طلبات.", "Secret details (owner, unit number, address, location, commission) show to the unit's broker and managers only. Another broker taps \"🔒 Ask for private details\" on a search result or card; a manager answers. If the agency opened them to all brokers, there are no requests."],
      ["مالك الشركة ممكن يعلّم وحدة «خاصة»: بتتخفى من البحث والقوايم لأي حد غيره، حتى المديرين.", "The agency owner can mark a unit private: it is hidden from search and lists for everyone else, managers included."],
      ["مالك الوحدة (البروفايل) متسجل لوحده بمكالماته ومتابعاته، ومتربط بوحداته. المدير يقدر يعدّل المالك، أو ينقل الوحدة لمالك تاني، أو لعميل اشترى.", "Each unit owner has their own profile, separate from clients, listing their units. A manager can edit the owner, move a unit to another owner, or to a client who bought it."]
    ]
  },
  {
    id: "search",
    title: ["🔍 البحث", "🔍 Search"],
    items: [
      ["اكتب أو سجّل اللي العميل عايزه بكلامك: «شقة في التجمع ٣ غرف تحت ١٠ مليون».", "Type or say what the client wants in your own words: \"apartment in New Cairo, 3 beds, under 10M\"."],
      ["النتايج بتيجي بصورة لكل وحدة؛ دوس على وحدة تشوف صورها وتفاصيلها.", "Results come with a photo per unit; tap one to see its photos and details."],
      ["«شوف الكل» بيفتح نفس البحث على الموقع عشان تفلتر أكتر.", "\"See all\" opens the same search on the website to filter further."]
    ]
  },
  {
    id: "clients",
    who: "leads",
    title: ["👤 العملاء", "👤 Clients"],
    items: [
      ["ابعت «ليد» ومعاه رسالة العميل أو فويس، أو حوّل رسالته، أو ابعت رقمه. البوت يعمل كارت العميل بعد ما تأكد.", "Send \"lead\" with the client's message or a voice note, forward their message, or send their number. The bot makes the client's card once you confirm."],
      ["عملاء إعلانات فيسبوك: المدير يحمل ملف CSV من Meta Leads Center في «العملاء ← تحميل».", "Facebook ad leads: a manager uploads the Meta Leads Center CSV under \"Leads → Import\"."],
      ["أزرار الكارت: 📞 كلمته، 📅 متابعة، 🔄 المرحلة. كل مرحلة بتتسجل في التقارير.", "Card buttons: 📞 Called, 📅 Follow-up, 🔄 Stage. Every stage counts in the reports."],
      ["محتاج مدير في عميل؟ من الكارت دوس 🔄 المرحلة واختار «🙋 محتاج مدير»، واكتب للمدير محتاج إيه (اختياري، أو ابعت من غير ملاحظة). المديرين بيتبلغوا فوراً.", "Need a manager on a client? From the card tap 🔄 Stage and choose \"🙋 Needs manager\", then write what you need (optional, or send it without a note). The managers are alerted straight away."],
      ["أو قول في فويس أو اكتب «محتاج المدير في ليد أحمد»، والبوت يعرضلك التأكيد قبل ما يحفظ.", "Or say or type \"I need my manager on Ahmed's lead\"; the bot shows you a confirmation before it saves."],
      ["المدير بيشوف العميل في «محتاجين مدير»، وبيقدر يكتب رد اختياري ويعلّمه «اتعالج»، والبروكر بيوصله الرد.", "The manager sees it under \"Needs manager\", can write an optional reply and mark it handled; the broker gets the reply."],
      ["عميل واحد ليه طلب مفتوح واحد بس؛ لو محتاج تاني، المدير الأول يعلّم اللي قبله اتعالج.", "A client has one open flag at a time; once the manager marks it handled, you can flag again."],
      ["احفظ طلب العميل («طلب» + اللي عايزه) وأول ما تنزل وحدة تناسبه أو سعرها ينزل هتتبلغ.", "Save the client's request (\"request\" + what they want) and you hear as soon as a unit fits or drops its price."],
      ["«عملائي» و«متابعات» بيجيبولك قوايمك في أي وقت.", "\"leads\" and \"followups\" bring up your lists any time."]
    ]
  },
  {
    id: "daily",
    who: "leads",
    title: ["⏰ رسايل اليوم", "⏰ Daily messages"],
    items: [
      ["الصبح (٩–١٢): ملخص متابعاتك وعملائك الجداد.", "Morning (9–12): your follow-ups and new clients."],
      ["المسا (٧–١٠) للمديرين: ملخص يوم الشركة.", "Evening (7–10), managers: the agency's day."],
      ["من «الإعدادات» تختار القناة لكل نوع تنبيه وساعات الهدوء؛ التنبيهات اللي بتيجي وقت الهدوء بتتجمع في رسالة واحدة بعده.", "In Settings you pick the channel for each alert and your quiet hours; alerts during quiet hours arrive together in one message afterwards."]
    ]
  },
  {
    id: "crm",
    who: "crm",
    title: ["🛠️ لمالك التطبيق", "🛠️ For the app owner"],
    items: [
      ["«متابعة التطبيق» و«اللوحة»: أرقام التطبيق كله (الشركات، الفلوس، الذكاء الاصطناعي، الأداء، جودة البحث، التشغيل). أرقام بس، من غير أسماء عملاء أو تليفونات.", "\"Tracking\" and \"Board\": numbers for the whole app (agencies, money, AI, performance, search quality, operations). Numbers only, no client names or phones."],
      ["تنبيهات التطبيق بتوصلك لو الأخطاء زادت فجأة، أو مكالمات الذكاء الاصطناعي بتفشل، أو شركة قربت تخلص رصيدها، أو دفعة مستنية أكتر من يوم. التنبيه الواحد مش بيتكرر قبل ٦ ساعات.", "App alerts reach you when errors jump, AI calls start failing, an agency nears the end of its credits, or a payment waits over a day. The same alert is not repeated within 6 hours."],
      ["الأرقام دي بتتظبط من إعدادات السيرفر: SYSTEM_ALERT_ERRORS_PER_HOUR وSYSTEM_ALERT_AI_FAIL_PCT وSYSTEM_ALERT_QUOTA_PCT وSYSTEM_ALERT_PAYMENT_HOURS وSYSTEM_ALERT_COOLDOWN_HOURS.", "The numbers are server settings: SYSTEM_ALERT_ERRORS_PER_HOUR, SYSTEM_ALERT_AI_FAIL_PCT, SYSTEM_ALERT_QUOTA_PCT, SYSTEM_ALERT_PAYMENT_HOURS and SYSTEM_ALERT_COOLDOWN_HOURS."]
    ]
  },
  {
    id: "managers",
    who: "manager",
    title: ["👥 للمديرين", "👥 For managers"],
    items: [
      ["«فريقي»: ضيف بروكر، اعمله لينك تيليجرام، أو أوقفه (عملاؤه بيرجعوا للمديرين).", "\"My team\": add a broker, make their Telegram link, or deactivate them (their clients come back to the managers)."],
      ["«لوحة الشركة»: العملاء والصفقات والعمولة وترتيب البروكرز لآخر ٧ أو ٣٠ أو ٩٠ يوم.", "\"Agency dashboard\": leads, deals, commission and the broker leaderboard for the last 7, 30 or 90 days."],
      ["حوّل عميل لبروكر: «حول L-0042 لـ سارة».", "Hand a client to a broker: \"assign L-0042 to Sara\"."],
      ["«سجل النشاط» (من القايمة): كل اللي اتعمل في الشركة لآخر ٩٠ يوم؛ طلبات البيانات الخاصة والتعديلات بتتسجل هنا.", "\"Activity log\" (in the menu): everything done in the agency for the last 90 days; requests for private details and edits are recorded there."],
      ["طلبات البيانات الخاصة بيرد عليها أي مدير؛ ولو مفيش مدير غير مالك الشركة، المالك هو اللي بيرد.", "Any manager can answer a private-details request; if the agency has no manager other than its owner, the owner answers."],
      ["مالك الشركة (أول حساب اتسجل للشركة): بيدير الخطة والدفع، وبيضيف أو بيشيل المديرين، وبيحدد هل البيانات الخاصة مفتوحة للكل أو للمديرين بس، وبيعلّم الوحدات الخاصة. وبيشوف كل اللي المديرين بيشوفوه.", "The agency owner (the first account of the agency): manages the plan and payments, adds or removes managers, chooses whether secret details are open to all brokers or to managers only, and marks units private. Sees everything the managers see."]
    ]
  },
  {
    id: "voice",
    title: ["🎙️ البحث بالصوت", "🎙️ Voice search"],
    items: [
      ["اضغط المايك جنب خانة البحث مرة عشان يبدأ، واتكلم، واضغط تاني عشان يقف ويدور. الصوت بيتكتب بالذكاء الاصطناعي ويتحسب من رصيد الفويس بتاع شركتك.", "Tap the mic beside the search box once to start, speak, then tap again to stop and search. The AI writes the speech down and it counts against your agency's voice allowance."],
      ["Enter على الكيبورد (أو زرار «بحث» على الآيفون) بيدور على الكلام المكتوب بس، ومبيفتحش المايك.", "Enter on the keyboard (or the Go key on iPhone) searches what you typed and never starts the mic."],
      ["لو مسمعناش حاجة بيقولك «مسمعناش كويس». لو الصوت فيه دوشة، الذكاء بيكتب أحسن تخمين وممكن يغلط، فراجع الكلام قبل ما تفتح النتايج.", "If nothing is heard, it says \"Couldn't hear you\". With noise, the AI writes its best guess, which can be wrong, so check the search before you act on the results."],
      ["لو الذكاء الاصطناعي مش متاح أو رصيد الشركة خلص، اضغط المايك تاني وهيستخدم صوت التليفون بتاعك بدل الذكاء. صوت التليفون بيقف لوحده بعد سكتة ويدور على اللي اتسمع.", "If the AI is down or your agency is out of credits, tap the mic again and your phone's own voice is used instead. The phone's voice stops by itself after a pause and searches what it heard."],
      ["المايك بيطلب إذن الميكروفون أول مرة بس؛ لو كل مرة بيطلبه، اسمح له من إعدادات المتصفح أو التليجرام.", "The microphone asks for permission the first time only; if it asks every time, allow it in your browser or Telegram settings."]
    ]
  }
];

const FAQ = [
  [["البحث بالصوت بيوقف لوحده؟", "Does voice search stop by itself?"], ["صوت التليفون بيوقف بعد سكتة. الذكاء بيسجّل لحد ما تضغط المايك تاني، فاضغط عشان يبدأ يدور.", "The phone's voice stops after a pause. The AI records until you tap the mic again, so tap it to start the search."]],
  [["إيه اللي بيحصل لو الرصيد خلص؟", "What happens when credits run out?"], ["المايك بيرجع يستخدم صوت التليفون، والبحث بالكتابة شغال زي ما هو.", "The mic falls back to your phone's voice, and typed search keeps working."]],
  [["هل بياناتي بيشوفها حد من شركة تانية؟", "Can another agency see my data?"], ["لأ. كل شركة شايفة وحداتها وعملاءها بس.", "No. Every agency sees only its own units and clients."]],
  [["العميل بيشوف إيه لما أبعتله لينك وحدة؟", "What does a client see when I send a unit link?"], ["صفحة فيها الصور والتفاصيل ورقم تواصل الشركة، من غير أي بيانات داخلية. لو الوحدة اتباعت اللينك بيقول إنها مبقتش متاحة.", "A page with the photos, the details and the agency's contact number, with no internal data. If the unit is sold the link says it's no longer available."]],
  [["العميل طلب يمسح بياناته؛ أعمل إيه؟", "A client asked us to delete their data. What do I do?"], ["المدير يفتح العميل على الموقع ويختار «مسح نهائي» ويكتب آخر ٤ أرقام من رقمه. وتقدر تصدّر بياناته الأول لو طلبها.", "A manager opens the client on the website, chooses \"Erase for good\" and types the last 4 digits of their number. You can export their data first if they ask for it."]],
  [["مين بيشوف البيانات الخاصة للوحدة؟", "Who sees a unit's private details?"], ["البروكر بتاع الوحدة والمديرين. أي بروكر تاني بيطلبها، والمدير بيرد، وكل طلب بيتسجل.", "The unit's broker and the managers. Any other broker asks, a manager answers, and every request is logged."]],
  [["المدير بيشوف الوحدات الخاصة بمالك الشركة؟", "Can managers see units the agency owner marked private?"], ["لأ. الوحدة الخاصة مخفية عن أي حد غير مالك الشركة، حتى المديرين.", "No. A private unit is hidden from everyone except the agency owner, managers included."]],
  [["البوت فهم غلط؛ أصلّحه إزاي؟", "The bot got something wrong. How do I fix it?"], ["قبل الحفظ دوس «✏️ تعديل». بعد الحفظ: «تعديل الكود السعر ٩٫٥ مليون» أو من الموقع.", "Before saving tap \"✏️ Edit\". After saving: \"edit CODE price 9.5M\" or use the website."]],
  [["في حاجة مش شغالة.", "Something isn't working."], ["ابعت «عطل» واللي حصل للبوت، أو «🐞 بلّغ عن مشكلة» تحت أي صفحة. هيوصلك رقم البلاغ.", "Send \"bug\" and what happened to the bot, or use \"🐞 Report a problem\" at the bottom of any page. You get a report number."]],
  [["ليه تيليجرام مش واتساب؟", "Why Telegram and not WhatsApp?"], ["تيليجرام مجاني للرسايل والصور والأزرار، فالتنبيهات مش بتتكلف. واتساب بيفضل للتواصل مع العملاء.", "Telegram is free for messages, photos and buttons, so alerts cost nothing. WhatsApp stays for talking to clients."]],
  [["الموقع بطيء أول ما بفتحه.", "The website is slow the first time I open it."], ["في فترة التجربة السيرفر بينام لما محدش بيستخدمه، وأول فتحة ممكن تاخد دقيقة.", "During the trial the server sleeps when nobody uses it, so the first load can take up to a minute."]]
];

const WEB_FAQ = [
  [["هل العميل يستطيع رؤية رقم تليفون المالك؟", "Will clients ever see the owner's phone number?"], ["لا نهائياً. روابط العملاء التي ترسلها تعرض فقط صور الوحدة والمواصفات وسعر البيع دون أي أرقام هواتف أو بيانات داخلية.", "Never. Client links that you share only display property photos, specifications and pricing. Internal notes and owner contacts remain strictly private to your agency."]],
  [["ماذا أفعل إذا لم أجد اسم الكمبوند في القائمة؟", "What if I don't find the compound in the dropdown?"], ["اكتب اسم الكمبوند واضغط عليه وسيتم تسجيله ككمبوند جديد تلقائياً في حساب وكالتك.", "Simply type the compound name and press Enter. The system will register it as a new compound in your agency account automatically."]],
  [["ماذا يعني التنبيه باللون الأصفر عند الحفظ؟", "What does the yellow warning box mean?"], ["هذا تنبيه ذكي لتذكيرك في حال وجود وحدة أخرى مسجلة بنفس السعر والمساحة، لتجنب تكرار إدخال نفس الوحدة عن طريق الخطأ.", "It is a smart check alerting you if another colleague already added the same property in your inventory, preventing duplicate listings."]],
  [["هل يمكنني تعديل الوحدة لاحقاً بعد حفظها؟", "Can I edit unit details later after saving?"], ["نعم، في أي وقت يمكنك الدخول على صفحة الوحدة والضغط على «✏️ تعديل» وتحديث أي بيانات أو صور.", "Yes, anytime! Simply open the unit card and click \"✏️ Edit\" to update prices, photos, or status."]]
];

const EXCEL_FAQ = [
  [["هل يستهلك استيراد الإكسيل من رصيد الذكاء الاصطناعي؟", "Does Excel import consume AI credits?"], ["لا نهائياً. قراءة ملفات الإكسيل (.xlsx و .csv) ومطابقة الأعمدة تتم بقواعد برمجية مجانية بالكامل داخل المتصفح (0 AI Credits).", "Never. Reading Excel spreadsheets (.xlsx and .csv) and column mapping runs purely rule-based inside the browser with zero AI credit consumption."]],
  [["ماذا يحدث إذا كان الملف يحتوي على شيتات فارغة؟", "What happens if the workbook contains empty sheets?"], ["يقوم النظام بفحص كل شيت واستبعاد الشيتات الفارغة تلقائياً بدون إيقاف عملية الاستيراد، ويوضح ذلك في تقرير المعاينة.", "The system inspects every tab and automatically skips empty sheets without halting the import, reporting them clearly in the preview."]],
  [["هل يمكنني التراجع عن عملية الاستيراد بعد تطبيقها؟", "Can I undo an applied import?"] , ["نعم، يحتفظ النظام بسجل كامل لآخر 10 عمليات استيراد لمدة 30 يوماً، مما يتيح لك حذف الوحدات المضافة أو استعادة الأسعار السابقة بنقرة واحدة.", "Yes! The system keeps a 30-day reversible undo stack for the last 10 imports, allowing you to delete newly added units or revert modified prices with one click."]],
  [["ما هي الأعمدة الإجبارية التي لا يمكن الاستيراد بدونها؟", "Which columns are mandatory for Excel import?"], ["الأعمدة الإجبارية الستة هي: الكمبوند، نوع الوحدة، الغرض (بيع أو إيجار)، السعر الإجمالي، المساحة، ورقم تليفون المالك.", "The 6 required columns are: Compound, Property Type, Purpose (Sale/Rent), Price, Area (sqm), and Owner Phone."]]
];

const CHAT_FAQ = [
  [["هل يتم حفظ رقم مرسل الواتساب كرقم لمالك الوحدة؟", "Is the WhatsApp sender's phone saved as the owner's phone?"], ["لا نهائياً. يتم حفظ رقم هاتف الراسل فقط كمرجع تسويقي في الملاحظات، ولا يتم اعتماده كرقم مالك الوحدة حفاظاً على السرية.", "Never. The sender's phone number is recorded strictly in the notes as an internal source reference and is never assigned as the unit owner's phone."]],
  [["ما هو الحد الأقصى لعدد الصور في الإعلان الواحد؟", "What is the maximum number of photos per listing?"], ["الحد الأقصى هو 15 صورة لكل وحدة. يتم اختيار الصورة الأولى تلقائياً كصورة غلاف، مع إمكانية إعادة الترتيب وحذف الصور المكررة.", "The ceiling is 15 photos per listing. The first image is automatically designated as the hero cover, with full controls to reorder and discard duplicates."]],
  [["ماذا يحدث لرسائل طلبات الشراء (Looking for) داخل الشات؟", "What happens to buyer request messages in the chat?"], ["يقوم الفلتر الذكي باستبعاد رسائل الطلبات (مثل «مطلوب» أو «محتاج») تلقائياً حتى لا يتم تسجيلها كوحدات بالمخزون.", "Smart filters automatically identify and exclude buyer inquiry messages (e.g., 'Looking for', 'Wanted', 'مطلوب') so they never clutter your property inventory."]],
  [["من يملك صلاحية استيراد شات الواتساب؟", "Who has permission to import WhatsApp chats?"], ["خاصية استيراد الشات متاحة للمديرين (Managers) ومدخلي البيانات (Data Entry) فقط، ومغلقة أمام البروكر العادي.", "WhatsApp chat intake is restricted to Managers and Data Entry clerks only; frontline brokers cannot access it."]]
];

const LEADS_FAQ = [
  [["ماذا يعني تنبيه تعارض الزملاء (Colleague Duplicate Guard)؟", "What is the Colleague Duplicate Guard?"], ["هو نظام حماية ذكي يمنع تكرار تسجيل العميل، وينبه المدير بوجود تعارض مع إخفاء بيانات العميل واسم الزميل لحماية سرية العمل داخل الوكالة.", "A collision guard preventing duplicate client intake: it alerts the manager while strictly concealing client data and colleague identity from the inquiring broker."]],
  [["كم مدة التراجع المتاحة بعد تعديل مرحلة العميل؟", "How long is the undo window after mutating a lead?"], ["متاح لك التراجع الفوري عن أي تغيير (مثل تغيير المرحلة أو المتابعة) خلال 10 دقائق كاملة عبر زر «↩️ تراجع».", "You have a 10-minute reversible window to rollback any lead mutation (stage shift, follow-up, note, assignment) via the undo button."]],
  [["كيف يحسب النظام مواعيد الرد في غير أوقات العمل؟", "How are response deadlines calculated outside working hours?"], ["تُحسب مهل الاستجابة حصراً خلال ساعات العمل بتوقيت القاهرة (9 ص إلى 9 م). الرسالة الواردة ليلاً يبدأ عدادها في التاسعة صباحاً.", "Response deadlines accrue strictly during Cairo working hours (e.g. 9:00 AM - 9:00 PM). A lead received at night pauses until 9:00 AM."]],
  [["كيف يتوافق النظام مع قانون حماية البيانات الشخصية المصري (PDPL)؟", "How does WehdatHub comply with Egyptian PDPL?"], ["يوفر النظام إمكانية تصدير بيانات العميل في ملف مضغوط، والمسح النهائي المشفر برقم الهاش (lead_erasures)، والتطهير التلقائي بعد 18 شهراً من الركود.", "Compliant with Egyptian Law 151/2020: exportable client ZIPs, phone-hashed permanent erasure (lead_erasures), and automatic 18-month inactivity purging."]]
];

/** A command's words as <code> chips. */
function commandWords(c, lang) {
  const arg = (en) => (en ? c.argEn || c.arg : c.arg);
  const chip = (w, en) => html`<code dir="${en ? "ltr" : "rtl"}">${w}${arg(en) ? ` ${arg(en)}` : ""}</code>`;
  const words = lang === "en" ? (c.en.length ? c.en : [c.enHint].filter(Boolean)).map((w) => chip(w, true)) : [...c.ar.map((w) => chip(w, false)), ...c.en.map((w) => chip(w, true))];
  const example = lang === "en" ? c.exampleEn || c.example : c.example;
  return words.length ? html`${words.map((x, i) => html`${i ? " / " : ""}${x}`)}` : html`<code dir="auto">${example}</code>`;
}

function visibleSections(broker) {
  if (Authz.isCrmOwner(broker)) return SECTIONS.filter((s) => s.id === "start" || s.who === "crm");
  return SECTIONS.filter((s) => (s.who === "crm" ? false : !s.who || (s.who === "manager" ? !broker || Authz.isManager(broker) : !Authz.isDataEntry(broker))));
}

function visibleGroups(broker) {
  if (Authz.isCrmOwner(broker)) return [];
  return Words.grouped()
    .filter((g) => !(g.id === "leads" && Authz.isDataEntry(broker)))
    .map((g) => ({ ...g, commands: g.commands.filter((c) => !c.manager || !broker || Authz.isManager(broker)) }))
    .filter((g) => g.commands.length);
}

/** 1. Telegram Bot Guide Content */
function telegramGuideContent(lang, broker) {
  const sections = visibleSections(broker);
  const crm = Authz.isCrmOwner(broker);
  return html`
<nav class="card row" aria-label="${T(lang, ["المحتوى", "Contents"])}">
  ${crm ? "" : html`<a href="#commands">📖 ${T(lang, ["الأوامر", "Commands"])}</a>`}
  ${sections.map((s) => html`<a href="#${s.id}">${T(lang, s.title)}</a>`)}
  <a href="#faq">❓ ${T(lang, ["أسئلة شائعة", "FAQ"])}</a>
</nav>

${crm ? "" : html`<section class="card" id="commands">
  <h2>📖 ${T(lang, ["أوامر البوت", "Bot commands"])}</h2>
  <p class="muted">${T(lang, ["العربي بأي طريقة كتابة (أ/ا، ة/ه، ى/ي زي بعض) والإنجليزي كابيتال أو سمول.", "English words work in any case. Arabic words work in any spelling (switch the guide to Arabic to see them)."])}</p>
  ${visibleGroups(broker).map((g) => html`<h3>${T(lang, g.title)}</h3><div class="scroll"><table data-commands="${g.id}"><tbody>${g.commands.map((c) => html`<tr><td>${commandWords(c, lang)}</td><td>${T(lang, c.help)}${c.manager ? T(lang, [" (للمديرين)", " (managers)"]) : ""}</td></tr>`)}</tbody></table></div>`)}
</section>`}

${sections.map(
  (s) => html`<section class="card" id="${s.id}">
  <h2>${T(lang, s.title)}</h2>
  <ul>${s.items.map((i) => html`<li>${T(lang, i)}</li>`)}</ul>
</section>`
)}

${crm ? "" : html`<section class="card" id="faq">
  <h2>❓ ${T(lang, ["أسئلة شائعة", "FAQ"])}</h2>
  ${FAQ.map(([q, a]) => html`<details><summary>${T(lang, q)}</summary><p>${T(lang, a)}</p></details>`)}
</section>`}`;
}

/** 2. Website Guide & Add/Edit Units Content */
function webGuideContent(lang, assets) {
  const shot = (file, caption) => html`
<figure class="guide-shot">
  <img src="${assets.url(file)}" alt="${caption}" loading="lazy">
  <figcaption>📸 ${caption}</figcaption>
</figure>`;

  return html`
<nav class="card row" aria-label="${T(lang, ["محتويات دليل الموقع", "Web Guide Contents"])}">
  <a href="#web-intro">💡 ${T(lang, ["مثال عملي", "Practical Example"])}</a>
  <a href="#web-add">➕ ${T(lang, ["إضافة وحدة", "Adding a Unit"])}</a>
  <a href="#web-compound">📍 ${T(lang, ["طلب كمبوند جديد", "New Compound"])}</a>
  <a href="#web-edit">✏️ ${T(lang, ["تعديل وحدة", "Editing a Unit"])}</a>
  <a href="#web-search">🔍 ${T(lang, ["البحث والفلاتر", "Search & Filters"])}</a>
  <a href="#web-faq">❓ ${T(lang, ["أسئلة شائعة", "Web FAQ"])}</a>
</nav>

<section class="card" id="web-intro">
  <h2>💡 ${T(lang, ["دليل المبتدئين: مثال عملي سنطبقه خطوة بخطوة", "Beginner's Walkthrough: A Real Example Step-by-Step"])}</h2>
  <p>${T(lang, [
    "صُمم هذا الدليل لمساعدتك على إضافة وتعديل الوحدات بسهولة عبر واجهة الموقع، خطوة بخطوة دون أي تعقيدات.",
    "This guide walks you through adding and editing properties on the website with clear steps, screenshots, and no technical jargon."
  ])}</p>
  <div class="guide-example">
    <strong>${T(lang, ["الوحدة التي سنطبق عليها الشرح:", "Sample Unit Used in This Guide:"])}</strong>
    <ul>
      <li>${T(lang, ["نوع الوحدة: شقة للبيع", "Listing Type: Apartment for Sale"])}</li>
      <li>${T(lang, ["المكان: كمبوند هايد بارك (التجمع الخامس - القاهرة الجديدة)", "Location: Hyde Park Compound (Fifth Settlement - New Cairo)"])}</li>
      <li>${T(lang, ["المواصفات: 165 متر مربع · 3 غرف نوم · 2 حمام · الدور الثالث · تشطيب كامل · بدون فرش", "Specifications: 165 m² · 3 Bedrooms · 2 Bathrooms · 3rd Floor · Fully Finished · Unfurnished"])}</li>
      <li>${T(lang, ["السعر: 5,500,000 جنيه مصري (كاش، استلام فوري)", "Price: 5,500,000 EGP (Cash, Ready to move)"])}</li>
      <li>${T(lang, ["المالك: أ/ محمد أحمد (موبايل: 01012345678 - بيانات سرية داخلية)", "Owner: Mohamed Ahmed (Mobile: 01012345678 - confidential internal data)"])}</li>
    </ul>
  </div>
</section>

<section class="card" id="web-add">
  <h2>➕ ${T(lang, ["خطوات إضافة وحدة جديدة (4 خطوات)", "How to Add a New Unit (4 Simple Steps)"])}</h2>
  <p class="muted">${T(lang, [
    "لإضافة وحدة: اضغط على زر «➕ إضافة» من القائمة أو ادخل على الرابط /app/units/new. النموذج مقسم إلى 4 خطوات متتالية:",
    "To add a unit: click \"➕ Add\" from the navigation or visit /app/units/new. The form guides you through 4 sequential steps:"
  ])}</p>

  <h3>${T(lang, ["الخطوة 1 من 4: نوع الوحدة والمكان", "Step 1 of 4: Unit Type and Location"])}</h3>
  <ul>
    <li>${T(lang, ["نوع العرض: اضغط على «بيع» (أو «إيجار» لوحدة معروضة للإيجار).", "Offer Type: click \"Sale\" (بيع) or \"Rent\" (إيجار)."])}</li>
    <li>${T(lang, ["نوع الوحدة: اختر نوع العقار (مثال: «شقة» أو فيلا، تاون هاوس، دوبلكس...).", "Unit Type: select the property category (e.g., Apartment / شقة, Villa, Townhouse...)."])}</li>
    <li>${T(lang, ["صندوق المكان والمميزات الموحد: اكتب اسم الكمبوند أو المنطقة (مثال: هايد بارك)، واضغط على الاقتراح الذكي ليتحول إلى بطاقة مسار زرقاء.", "Unified Place Box: type the compound name (e.g. Hyde Park) and pick the matching suggestion to lock its geographic hierarchy."])}</li>
    <li>${T(lang, ["المميزات: اكتب أي ميزة إضافية في نفس الخانة (مثال: غرفة مربية، بحري) لتضاف كرقاقة مميزات.", "Features: type additional perks (e.g., Nanny room, Sea view) in the same box to add them as badges."])}</li>
    <li>${T(lang, ["اضغط زر «التالي» الأزرق في أسفل الشاشة.", "Click the blue \"Next\" (التالي) button at the bottom."])}</li>
  </ul>
  ${shot("guide/add-unit-01-place-features.png", T(lang, ["الخطوة 1: نوع الوحدة، الكمبوند، وصندوق المكان والمميزات الموحد", "Step 1: Unit type, compound, and the unified place & feature box"]))}

  <h3>${T(lang, ["الخطوة 2 من 4: المساحة والسعر", "Step 2 of 4: Size and Price"])}</h3>
  <ul>
    <li>${T(lang, ["المساحة: اكتب المساحة الإجمالية بالأرقام (مثال: 165).", "Area: enter the total square meters in numbers (e.g., 165)."])}</li>
    <li>${T(lang, ["الغرف والحمامات والدور: اضغط على أزرار الأرقام بنقرة واحدة (مثال: 3 غرف، 2 حمام، دور 3).", "Rooms & Floor: click the buttons for bedrooms (3), bathrooms (2), and floor level (3)."])}</li>
    <li>${T(lang, ["التشطيب والفرش: اختر حالة التشطيب (تشطيب كامل) وحالة الفرش (بدون فرش).", "Finishing & Furnishing: select Finishing (Fully Finished) and Furnishing (Unfurnished)."])}</li>
    <li>${T(lang, ["السعر والعملة: اكتب إجمالي السعر (5500000) وتأكد من اختيار العملة (EGP أو USD).", "Price & Currency: enter the total amount (5500000) and pick the currency (EGP or USD)."])}</li>
    <li>${T(lang, ["اضغط زر «التالي».", "Click the \"Next\" (التالي) button."])}</li>
  </ul>
  ${shot("guide/add-unit-02-size-price.png", T(lang, ["الخطوة 2: تحديد المساحة، الغرف، الحمامات، التشطيب، والسعر", "Step 2: Entering area, bedrooms, bathrooms, finishing, and asking price"]))}

  <h3>${T(lang, ["الخطوة 3 من 4: الاستلام ونظام السداد", "Step 3 of 4: Delivery and Payment Terms"])}</h3>
  <ul>
    <li>${T(lang, ["موعد الاستلام: إذا كانت الوحدة جاهزة، ضع علامة صح داخل مربع «استلام فوري». إذا كانت تحت الإنشاء، حدد سنة الاستلام والربع السنوي.", "Delivery: if the unit is finished, tick \"Immediate Delivery / Ready to move\" (استلام فوري); otherwise specify delivery year & quarter."])}</li>
    <li>${T(lang, ["طريقة الدفع: في حالة الكاش، اكتب المبلغ في خانة «المدفوع كاش المطلوب» (5500000) واترك الأقساط فارغة.", "Payment: for cash deals, enter full price in \"Required Cash Amount\" (المدفوع كاش المطلوب) and leave installments empty."])}</li>
    <li>${T(lang, ["في حالة التقسيط: حدد المقدم المطلوب، المتبقي من الأقساط، قيمة القسط ونظامه (شهري/ربع سنوي)، وتاريخ آخر قسط.", "For installment plans: enter cash down payment, remaining installments, installment value & frequency, and final date."])}</li>
    <li>${T(lang, ["اضغط زر «التالي».", "Click the \"Next\" (التالي) button."])}</li>
  </ul>
  ${shot("guide/add-unit-03-delivery-payment.png", T(lang, ["الخطوة 3: تحديد حالة الاستلام الفوري وتفاصيل الدفع كاش أو أقساط", "Step 3: Specifying delivery status and cash or installment schedule"]))}

  <h3>${T(lang, ["الخطوة 4 من 4: المالك، الصور، والمراجعة قبل الحفظ", "Step 4 of 4: Owner Details, Photos & Pre-Save Review"])}</h3>
  <ul>
    <li>${T(lang, ["بيانات المالك: اكتب اسم المالك (محمد أحمد) ورقم الموبايل (01012345678). 🔒 تنبيه: رقم المالك سري ومحمي تماماً ولن يظهر للعملاء أبداً.", "Owner Information: enter owner name and mobile (01012345678). 🔒 Note: owner details are strictly private and never exposed to clients."])}</li>
    <li>${T(lang, ["الوصف التسويقي: اضغط على زرار «✨ اكتب الوصف من بيانات الوحدة» ليقوم الموقع تلقائياً بصياغة رسالة تسويقية ممتازة للعملاء.", "Marketing Description: click \"✨ Write description from unit data\" to automatically generate an attractive summary for clients."])}</li>
    <li>${T(lang, ["الصور: اضغط على مربع الصور لاختيار حتى 15 صورة من جهازك، أو اسحب الصور مباشرة للمربع.", "Photos: click the photo box to select up to 15 property images, or drag & drop image files."])}</li>
    <li>${T(lang, ["المراجعة: اضغط «📋 مراجعة قبل الحفظ» للتأكد من اكتمال كافة البيانات.", "Review: click \"📋 Review before saving\" (مراجعة قبل الحفظ) to double-check all fields."])}</li>
    <li>${T(lang, ["الحفظ النهائي: اضغط زر «✅ حفظ» الأخضر. مبروك! تم حفظ الوحدة وتوليد كود مميز لها (مثل HP301).", "Save: click the green \"✅ Save\" (حفظ) button. Congratulations! Your unit is saved with its unique code (e.g., HP301)."])}</li>
  </ul>
  ${shot("guide/add-unit-04-owner.png", T(lang, ["الخطوة 4 أ: بيانات المالك السرية والوصف التسويقي التلقائي", "Step 4A: Private owner contact and auto-generated marketing description"]))}
  ${shot("guide/add-unit-05-photos-review.png", T(lang, ["الخطوة 4 ب: رفع الصور، قائمة الفحص، وزر الحفظ النهائي", "Step 4B: Uploading photos, pre-save checklist, and final save button"]))}
</section>

<section class="card" id="web-compound">
  <h2>📍 ${T(lang, ["طلب كمبوند جديد (إذا لم تجده في القائمة)", "How to Request a New Compound"])}</h2>
  <p>${T(lang, [
    "إذا كتبت اسم الكمبوند في خانة المكان ولم تجده مسجلاً من قبل، يمكنك طلبه وإضافته فوراً أثناء إدخال الوحدة:",
    "If you type a compound name that is not yet registered in the system, you can request and add it on the spot:"
  ])}</p>
  <ol>
    <li>${T(lang, ["اكتب اسم الكمبوند في خانة المكان (مثال: «كمبوند النرجس جرينز»).", "Type the compound name in the Place box (e.g. \"El Narges Greens\")."])}</li>
    <li>${T(lang, ["في نهاية قائمة الاقتراحات، اضغط على الخيار المميز: «اطلب مكان جديد: اسم الكمبوند».", "At the bottom of the suggestions dropdown, click: \"Request a new place: compound name\"."])}</li>
    <li>${T(lang, ["تفتح لك استمارة طلب الكمبوند الجديد لتحديد المدينة والموقع.", "The new compound form expands to define parent area and location."])}</li>
  </ol>
  ${shot("guide/add-unit-01b-new-compound.png", T(lang, ["استمارة طلب كمبوند جديد وتحديد المنطقة والبيانات", "Requesting a new compound with area selection and details"]))}
</section>

<section class="card" id="web-edit">
  <h2>✏️ ${T(lang, ["خطوات تعديل وحدة قائمة", "How to Edit an Existing Unit"])}</h2>
  <p class="muted">${T(lang, [
    "لتحديث السعر أو استبدال الصور أو تغيير أي معلومة: افتح صفحة الوحدة واضغط على زرار «✏️ تعديل».",
    "To adjust price, reorder photos, or edit details: open the unit card and click \"✏️ Edit\"."
  ])}</p>

  <h3>${T(lang, ["1. تعديل المواصفات والأسعار", "1. Updating Specifications and Pricing"])}</h3>
  <ul>
    <li>${T(lang, ["تحديث أي حقل مباشرة (مثل السعر أو حالة الوحدة إلى مباعة). الحماية التزامنية تمنع تعارض تعديل الزملاء.", "Update any field directly. Concurrency locks prevent collision if colleagues edit simultaneously."])}</li>
  </ul>
  ${shot("guide/edit-unit-01-place-features.png", T(lang, ["شاشة التعديل: شريط التنقل السريع والمكان والمواصفات", "Edit Screen: Quick navigation bar, location, and property specifications"]))}
  ${shot("guide/edit-unit-02-size-price.png", T(lang, ["تعديل المساحة والسعر وحالة التشطيب والفرش", "Updating area, asking price, finishing, and furnishing"]))}

  <h3>${T(lang, ["2. ترتيب وحذف الصور واختيار الصورة الرئيسية", "2. Reordering & Managing Photos"])}</h3>
  <ul>
    <li>${T(lang, ["أزرار «↑» و «↓» لتقديم الصورة واختيار الغلاف، وزر «احذف» لإزالة أي صورة.", "Click \"↑\" or \"↓\" to pick the primary cover photo, and \"Delete\" to remove any image."])}</li>
  </ul>
  ${shot("guide/edit-unit-04-photos-gallery.png", T(lang, ["معرض صور الوحدة: أزرار الترتيب (↑ / ↓) والحذف والرفع", "Photo Management: Order buttons (↑ / ↓), deletion, and new uploads"]))}

  <h3>${T(lang, ["3. تنبيه الوحدات المكررة الذكي والحفظ", "3. Smart Duplicate Listing Alert & Save"])}</h3>
  <ul>
    <li>${T(lang, ["تنبيه أصفر ذكي عند تشابه الوحدة مع أخرى في المخزون لحماية قاعدة البيانات من التكرار.", "Smart duplicate alert flags existing properties matching specs before saving."])}</li>
  </ul>
  ${shot("guide/edit-unit-05-review-summary.png", T(lang, ["تنبيه كشف الوحدات المتشابهة، خانة التأكيد، وزر حفظ التعديلات", "Duplicate listing detection alert, confirmation checkbox, and Save button"]))}
</section>

<section class="card" id="web-search">
  <h2>🔍 ${T(lang, ["دليل البحث واستعراض الوحدات", "The Search Process & Browsing Inventory"])}</h2>
  <p class="muted">${T(lang, [
    "يوفر موقع WehdatHub محرك بحث ذكي يتيح لك العثور على أي وحدة بالذكاء الاصطناعي أو بالصوت أو عبر الفلاتر المتقدمة:",
    "WehdatHub provides an intelligent search engine to find properties using natural language AI, voice notes, or detailed filters:"
  ])}</p>

  <h3>${T(lang, ["1. البحث باللغة الطبيعية والذكاء الاصطناعي", "1. Natural Language & AI Search"])}</h3>
  <ul>
    <li>${T(lang, ["اكتب طلب العميل بأسلوبك الطبيعي (مثال: «شقة في التجمع تحت 9 مليون»).", "Type naturally like \"apartment in New Cairo under 9M\"."])}</li>
    <li>${T(lang, ["يقوم الذكاء الاصطناعي بتحليل النص وعرض الشارة: «🤖 قرأها الذكاء الاصطناعي».", "AI parses query filters and displays the verified AI badge."])}</li>
  </ul>
  ${shot("guide/search-01-results.png", T(lang, ["شاشة نتائج البحث بالذكاء الاصطناعي وكروت الوحدات", "Search results screen with AI query parsing and unit cards"]))}

  <h3>${T(lang, ["2. الفلاتر المتقدمة وتعديل البحث (Refine Filters)", "2. Advanced Refine Filters"])}</h3>
  <ul>
    <li>${T(lang, ["لوحة فلاتر شاملة: السعر، المساحة، الغرف، الأدوار، أنظمة السداد، والاستلام الفوري.", "Comprehensive drawer: price, area, rooms, floors, payment schedule, and immediate delivery."])}</li>
  </ul>
  ${shot("guide/search-02-refine-filters.png", T(lang, ["لوحة الفلاتر المتقدمة لتحديد السعر والمساحة وأنظمة السداد", "Comprehensive filter drawer with price, size, finishing, and payment controls"]))}
</section>

<section class="card" id="web-faq">
  <h2>❓ ${T(lang, ["أسئلة شائعة عن استخدام الموقع (FAQ)", "Website Beginner FAQ"])}</h2>
  ${WEB_FAQ.map(([q, a]) => html`<div class="faq-item" style="margin-bottom: 14px;"><strong>❓ ${T(lang, q)}</strong><p style="margin: 4px 0 0;">${T(lang, a)}</p></div>`)}
</section>`;
}

/** 3. Excel Import Guide Content (R1) */
function excelGuideContent(lang, assets) {
  const shot = (file, caption) => html`
<figure class="guide-shot">
  <img src="${assets.url(file)}" alt="${caption}" loading="lazy">
  <figcaption>📸 ${caption}</figcaption>
</figure>`;

  return html`
<nav class="card row" aria-label="${T(lang, ["محتويات دليل إكسيل", "Excel Guide Contents"])}">
  <a href="#excel-upload">📑 ${T(lang, ["رفع الملف والشيتات", "Upload & Sheets"])}</a>
  <a href="#excel-mapping">🔤 ${T(lang, ["مطابقة الأعمدة", "Column Mapping"])}</a>
  <a href="#excel-diff">🔍 ${T(lang, ["مراجعة الفروق", "Diff Preview"])}</a>
  <a href="#excel-rules">🛡️ ${T(lang, ["قواعد التشغيل ومنع التكرار", "Rules & Dedup"])}</a>
  <a href="#excel-faq">❓ ${T(lang, ["أسئلة شائعة", "Excel FAQ"])}</a>
</nav>

<section class="card" id="excel-upload">
  <h2>📑 ${T(lang, ["الخطوة 1: رفع ملف الإكسيل والتعامل مع الشيتات المتعددة", "Step 1: Uploading Excel Workbooks & Multi-Sheet Processing"])}</h2>
  <p>${T(lang, [
    "تتيح لك ميزة استيراد الإكسيل (/app/import/excel) تحميل محفظة عقاراتك كاملة في ثوانٍ. تتم قراءة الملفات في المتصفح مباشرة عبر تقنية Web Workers بدون إرهاق السيرفر وبدون استهلاك أي رصيد من الذكاء الاصطناعي (0 AI Credits).",
    "Excel import (/app/import/excel) uploads entire property portfolios in seconds. Files are parsed in-browser via Web Workers with zero server load and zero AI credit consumption."
  ])}</p>

  <div class="guide-example">
    <strong>${T(lang, ["قواعد ملفات الإكسيل والشيتات المتعددة:", "Workbook & Multi-Sheet Rules:"])}</strong>
    <ul>
      <li>${T(lang, ["الصيغ المدعومة: يقبل النظام ملفات .xlsx وملفات .csv بحجم يصل إلى 5 ميجابايت.", "Supported Formats: accepts .xlsx and .csv workbooks up to 5 MB."])}</li>
      <li>${T(lang, ["الشيتات المتعددة (Multi-sheet): يدعم النظام المصنفات الضخمة التي تضم حتى 60 شيت (Sheet) وما يصل إلى 5,000 صف عقاري في المرة الواحدة.", "Multi-Sheet Support: handles workbooks with up to 60 sheets and up to 5,000 unit rows per import."])}</li>
      <li>${T(lang, ["استبعاد الشيتات الفارغة تلقائياً: الشيتات التي لا تحتوي على بيانات يتم استبعادها الذاتي دون إيقاف باقي الشيتات.", "Empty Sheets: sheets without valid data are safely skipped while active sheets proceed smoothly."])}</li>
      <li>${T(lang, ["توليد الكمبوند من اسم التاب: إذا كان الشيت مخصصاً لكمبوند معين ولا يحتوي عموداً لاسم الكمبوند، يعتمد النظام اسم التاب تلقائياً كاسم للكمبوند.", "Compound from Tab: if a sheet lacks a compound column, the tab name automatically assigns the compound."])}</li>
      <li>${T(lang, ["صلاحية الاستيراد: خاصية استيراد الإكسيل مقتصرة حصرياً على مديري الوكالة ومالكها (Authz.isManager).", "Role Gate: Excel import is strictly restricted to Agency Owners and Managers (Authz.isManager)."])}</li>
    </ul>
  </div>
  ${shot("guide/import-excel-01-upload-sheets.png", T(lang, ["منطقة رفع ملف الإكسيل واختيار الشيتات واستبعاد الشيتات الفارغة", "Excel upload dropzone, multi-sheet selection, and empty sheet exclusion"]))}
</section>

<section class="card" id="excel-mapping">
  <h2>🔤 ${T(lang, ["الخطوة 2: التعرف التلقائي على الأعمدة وتصحيح الأخطاء الإملائية", "Step 2: Header Detection & Typo-Tolerant Column Mapping"])}</h2>
  <p>${T(lang, [
    "يحتوي محرك الاستيراد على خوارزمية تعرف ذكية تقارن عناوين الأعمدة في ملفك مع الحقول المعتمدة في WehdatHub، حتى لو كانت الكلمات تحتوي على أخطاء إملائية شائعة.",
    "The import engine features smart fuzzy distance matching that accurately detects headers even with common typos."
  ])}</p>

  <h3>${T(lang, ["الأعمدة الإجبارية والحقول الأساسية", "Required Columns & Mandatory Fields"])}</h3>
  <ul>
    <li>${T(lang, ["الأعمدة الإجبارية الستة: الكمبوند (Compound)، نوع الوحدة (Property Type)، الغرض (بيع أو إيجار Purpose)، السعر (Price)، المساحة (Area)، ورقم تليفون المالك (Owner Phone).", "Mandatory Columns: Compound, Property Type, Purpose (Sale/Rent), Price, Area, and Owner Phone."])}</li>
    <li>${T(lang, ["تصحيح الأخطاء التلقائي: يتعرف النظام تلقائياً على الكلمات المشوهة مثل (descibation, deatils, phone numper) ويربطها بالحقل الصحيح.", "Typo Tolerance: words like 'descibation', 'deatils', or 'phone numper' are automatically recognized and mapped."])}</li>
    <li>${T(lang, ["كشف انزياح الأعمدة (Shifted Headers): إذا كان هناك عمود فارغ تسبب في زحزحة البيانات، ينبهك النظام ويعيد محاذاة الأعمدة هندسياً.", "Shifted Headers: detects offset columns and automatically realigns data cells."])}</li>
    <li>${T(lang, ["إعادة التعيين اليدوي: يمكنك في أي وقت فتح بطاقة الأدوات وتغيير مطابقة أي عمود وإعادة الحساب فوراً.", "Manual Remapping: open Tools to reassign any column mapping and recalculate on the fly."])}</li>
  </ul>
  ${shot("guide/import-excel-02-mapping-headers.png", T(lang, ["شاشة مطابقة الأعمدة والتعرف الذكي على الحقول والأخطاء الإملائية", "Column mapping interface with smart header detection and typo correction"]))}
</section>

<section class="card" id="excel-diff">
  <h2>🔍 ${T(lang, ["الخطوة 3: شاشة معاينة الفروق والتعديلات قبل الحفظ (Diff Preview)", "Step 3: Pre-Import Diff Preview & Row Categorization"])}</h2>
  <p>${T(lang, [
    "قبل أن يدخل أي تعديل إلى قاعدة البيانات الحية، يعرض لك النظام شاشة معاينة تفصيلية (/app/import/:id) تصنف كل صف في ملفك بدقة متناهية:",
    "Before committing changes to the live database, the diff preview screen (/app/import/:id) classifies every row:"
  ])}</p>

  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px;">
    <div class="notice ok">
      <strong>🆕 جديدة (New):</strong>
      <p style="margin: 4px 0 0; font-size: 12px;">${T(lang, ["وحدة جديدة لم تسجل من قبل. سيتم إنشاؤها وتوليد كود مميز لها.", "Brand new listing. Will be created with an auto-generated unique code."])}</p>
    </div>
    <div class="notice" style="border-inline-start-color: #1971c2;">
      <strong>✏️ متغيرة (Changed):</strong>
      <p style="margin: 4px 0 0; font-size: 12px;">${T(lang, ["وحدة مسجلة بالفعل حدث تغيير في سعرها أو مواصفاتها. يظهر لك النظام التغيير بوضوح: السعر القديم ➡ السعر الجديد.", "Existing listing with detected modifications, rendered as an inline diff: Old Price ➡ New Price."])}</p>
    </div>
    <div class="notice warn">
      <strong>⚠️ مراجعة (Review):</strong>
      <p style="margin: 4px 0 0; font-size: 12px;">${T(lang, ["وحدة متشابهة في المواصفات بنسبة تتجاوز 90% (قاعدة P13). يوفر لك النظام خيارين: إما الدمج مع الوحدة القديمة أو الإضافة كوحدة جديدة.", "Matches an existing unit within ±5% specs (P13 rule). Choose between Merge into existing or Add as new code."])}</p>
    </div>
    <div class="notice">
      <strong>✔️ متطابقة (Unchanged):</strong>
      <p style="margin: 4px 0 0; font-size: 12px;">${T(lang, ["بيانات مطابقة تماماً للمسجل في التطبيق. يتم تخطيها تلقائياً لتوفير الوقت.", "Identical to current inventory records. Safely skipped by default."])}</p>
    </div>
  </div>
  ${shot("guide/import-excel-03-diff-preview.png", T(lang, ["شاشة معاينة الفروق والتعديلات وتصنيف الصفوف قبل الحفظ", "Diff preview screen displaying row classifications and inline changes"]))}
</section>

<section class="card" id="excel-rules">
  <h2>🛡️ ${T(lang, ["الخطوة 4: قواعد التشغيل · منع التكرار P13 وحدود السعة والتراجع", "Step 4: Operational Rules, P13 Safeguards, Quotas & Undo Stack"])}</h2>
  <p>${T(lang, [
    "لحماية مخزون الوكالة من التشويه أو ضياع البيانات، يطبق WehdatHub ضوابط تشغيلية صارمة:",
    "To protect your agency's inventory integrity, WehdatHub enforces robust operational safeguards:"
  ])}</p>

  <h3>${T(lang, ["1. قاعدة منع التكرار الهندسية (P13 Rule)", "1. P13 Geometric Deduplication Safeguard"])}</h3>
  <p>${T(lang, [
    "يقارن النظام 5 معايير هندسية متزامنة: (الكمبوند، نوع العقار، عدد الغرف، المساحة بفارق ±5%، والسعر بفارق ±5%). في حال التطابق، يمنع النظام التكرار العشوائي ويوجه الصف إلى قسم «المراجعة» لاتخاذ القرار الأنسب.",
    "Evaluates 5 concurrent parameters: Compound, Property Type, Bedrooms, Area (±5%), and Price (±5%). Matches are flagged under 'Review' to prevent duplicate pollution."
  ])}</p>

  <h3>${T(lang, ["2. فحص سعة باقة الوكالة (Agency Unit Quota)", "2. Agency Plan Unit Capacity Quota"])}</h3>
  <p>${T(lang, [
    "يفحص النظام تلقائياً السعة المتبقية في باقة وكالتك قبل بدء الحفظ. إذا تجاوز الملف سعة الباقة، يحفظ النظام الوحدات حتى اكتمال السعة ويضع باقي الصفوف في قائمة التخطي الآمن (limit_skipped) دون أي عطل.",
    "Automatically verifies remaining unit capacity on your agency plan. If an import exceeds quota, units up to capacity are saved while surplus rows are safely held in 'limit_skipped' without data loss."
  ])}</p>

  <h3>${T(lang, ["3. التراجع الشامل خلال 30 يوماً (Reversible Undo)", "3. 30-Day Reversible Undo Stack"])}</h3>
  <p>${T(lang, [
    "أي عملية استيراد إكسيل يمكن التراجع عنها بالكامل خلال 30 يوماً عبر الرابط /app/import/:id/undo. يتم حذف الوحدات التي تم إنشاؤها (مما يحرر سعة الباقة فوراً) وإعادة الأسعار والمواصفات السابقة للوحدات المحدثة.",
    "Any applied import can be fully rolled back within 30 days via /app/import/:id/undo, deleting created listings (restoring plan quota) and restoring prior field values."
  ])}</p>
  ${shot("guide/import-excel-04-rules-dedup.png", T(lang, ["قواعد كشف التكرار P13 وفحص سعة الباقة وإمكانية التراجع الكامل", "P13 duplicate rules, quota checks, and 30-day reversible undo"]))}
</section>

<section class="card" id="excel-faq">
  <h2>❓ ${T(lang, ["أسئلة شائعة عن استيراد الإكسيل", "Excel Import FAQ"])}</h2>
  ${EXCEL_FAQ.map(([q, a]) => html`<div class="faq-item" style="margin-bottom: 14px;"><strong>❓ ${T(lang, q)}</strong><p style="margin: 4px 0 0;">${T(lang, a)}</p></div>`)}
</section>`;
}

/** 4. WhatsApp Chat Intake Guide Content (R2) */
function chatGuideContent(lang, assets) {
  const shot = (file, caption) => html`
<figure class="guide-shot">
  <img src="${assets.url(file)}" alt="${caption}" loading="lazy">
  <figcaption>📸 ${caption}</figcaption>
</figure>`;

  return html`
<nav class="card row" aria-label="${T(lang, ["محتويات دليل شات واتساب", "WhatsApp Chat Intake Contents"])}">
  <a href="#chat-upload">📦 ${T(lang, ["رفع الشات والفلاتر", "Upload & Filters"])}</a>
  <a href="#chat-extract">📝 ${T(lang, ["استخراج العقارات", "Extraction"])}</a>
  <a href="#chat-photos">📸 ${T(lang, ["ربط الصور والترتيب", "Photos & Order"])}</a>
  <a href="#chat-assign">👤 ${T(lang, ["التخصيص والأمان", "Assignment & Rules"])}</a>
  <a href="#chat-faq">❓ ${T(lang, ["أسئلة شائعة", "Chat FAQ"])}</a>
</nav>

<section class="card" id="chat-upload">
  <h2>📦 ${T(lang, ["الخطوة 1: رفع أرشيف الشات وتحديد النطاق الزمني", "Step 1: Uploading WhatsApp Export Archives & Date Range Filtering"])}</h2>
  <p>${T(lang, [
    "يتيح لك تبويب استيراد الشات (/app/import) تحويل محادثات ومجموعات واتساب العقارية إلى وحدات منظمة مع صورها بنقرة واحدة، دون الحاجة لإدخال يدوي.",
    "WhatsApp chat intake (/app/import) converts group chats and forwarded listings into structured listings complete with matched photos."
  ])}</p>

  <div class="guide-example">
    <strong>${T(lang, ["آلية المعالجة والفلترة الزمنية:", "Processing Mechanics & Date Filters:"])}</strong>
    <ul>
      <li>${T(lang, ["معالجة كاملة داخل المتصفح: يتم فك ضغط ملف .zip وقراءة الصور وسجل المحادثة _chat.txt داخل المتصفح (Client-side JSZip). لا يتم إرسال ملفات ضخمة للسيرفر مما يمنع انقطاع الاتصال.", "In-Browser Unpacking: .zip archives and photos are parsed directly in the user's browser via JSZip, avoiding server memory spikes and upload timeouts."])}</li>
      <li>${T(lang, ["استهلاك الذكاء الاصطناعي: 0 كريديت! المعالجة تتم بقواعد هندسية ولغوية متطورة دون استهلاك رصيد الذكاء الاصطناعي لوكالتك.", "AI Credit Consumption: 0 Credits! Operates 100% rule-based without consuming your agency's AI quota."])}</li>
      <li>${T(lang, ["خيارات النطاق الزمني: يدعم النظام فلاتر متعددة: آخر 7 أيام، آخر 30 يوماً (الافتراضي)، آخر 90 يوماً، كل الشات، أو «منذ آخر استيراد» الذكي الذي يقرأ فقط الإعلانات الجديدة منذ آخر عملية.", "Date Range Controls: filter by Last 7 days, Last 30 days (default), Last 90 days, All time, or smart incremental 'Since last import'."])}</li>
      <li>${T(lang, ["صلاحية الاستيراد: مقتصرة على المديرين ومدخلي البيانات (Authz.isManager || Authz.isDataEntry).", "Role Gate: restricted to Managers and Data Entry operators (Authz.isManager || Authz.isDataEntry)."])}</li>
    </ul>
  </div>
  ${shot("guide/import-chat-01-upload-filters.png", T(lang, ["شاشة رفع أرشيف شات واتساب وتحديد النطاق الزمني", "WhatsApp chat zip upload interface and date range controls"]))}
</section>

<section class="card" id="chat-extract">
  <h2>📝 ${T(lang, ["الخطوة 2: استخراج الإعلانات وتصفية طلبات الشراء (Looking for)", "Step 2: Listing Extraction & Filtering Out Buyer Requests"])}</h2>
  <p>${T(lang, [
    "يحلل النظام نصوص المحادثات بدقة هندسية عالية لتمييز الوحدات الحقيقية المعروضة للبيع أو الإيجار وفصلها عن الرسائل العشوائية وطلبات البحث:",
    "The parser analyzes chat text to extract genuine listings while discarding casual conversation and buyer requests:"
  ])}</p>

  <ul>
    <li>${T(lang, ["معايير الإعلان المكتمل (looksLikeListing): يجب ألا يقل طول الرسالة عن 30 حرفاً، وتحتوي على رقم/كلمة سعر (مثل مليون، ألف، EGP)، وكلمة عقارية ومساحة (شقة، فيلا، م²).", "Listing Criteria (looksLikeListing): minimum 30 characters, requiring price cues (million, k, EGP) and property keywords/area (apartment, villa, sqm)."])}</li>
    <li>${T(lang, ["استبعاد طلبات المشترين (Looking for Filters): الرسائل التي تبدأ بكلمات طلب (مطلوب، عايز، محتاج، ابحث عن، looking for) يتم استبعادها تلقائياً ولا تُسجل كوحدات بالمخزون.", "Request Filtering: buyer inquiries starting with 'looking for', 'مطلوب', 'عايز' are filtered out automatically."])}</li>
    <li>${T(lang, ["دعم التنسيقات: يدعم النظام صيغ تصدير واتساب على أجهزة آيفون (iOS) وأندرويد (Android) بمختلف لغات النظام.", "Cross-Platform Support: seamlessly parses both iOS and Android WhatsApp timestamp formats in Arabic and English."])}</li>
  </ul>
  ${shot("guide/import-chat-02-parse-extract.png", T(lang, ["شاشة استخراج بيانات العقار من رسالة الواتساب واستبعاد طلبات البحث", "Property listing extraction preview and buyer request filtering"]))}
</section>

<section class="card" id="chat-photos">
  <h2>📸 ${T(lang, ["الخطوة 3: ربط الصور بالعقارات ومنع التكرار وسقف 15 صورة", "Step 3: Photo Attachment, Perceptual Hash Dedup & 15-Photo Ceiling"])}</h2>
  <p>${T(lang, [
    "تعتبر مطابقة الصور بالنصوص التحدي الأكبر في جروبات الواتساب. يوفر WehdatHub خوارزمية ذكية لمطابقة الصور بإعلاناتها الصحيحة بدقة فائقة:",
    "Attaching photos to their matching descriptions is handled through sophisticated burst clustering and visual hashing:"
  ])}</p>

  <h3>${T(lang, ["قواعد مطابقة وترتيب الصور", "Photo Matching & Ordering Rules"])}</h3>
  <ul>
    <li>${T(lang, ["تجميع الرسائل المتتالية (Burst Window): يجمع النظام الصور والنصوص المرسلة في نافذة زمنية واحدة (الافتراضي 10 دقائق) من نفس الراسل.", "Burst Window: clusters messages and attachments sent within a 10-minute gap by the same participant."])}</li>
    <li>${T(lang, ["إشارات الاتجاه في النص: يتعرف النظام تلقائياً على عبارات التوجيه في نص الرسالة (مثل «صور فوق» أو «صور تحت») ويربط الصور بالاتجاه المناسب.", "Direction Cues: detects phrases like 'صور فوق' (photos above) or 'صور تحت' (photos below) to pair media correctly."])}</li>
    <li>${T(lang, ["الفحص الإدراكي للصور ومنع التكرار (Perceptual Hashing): يفحص النظام بصمة كل صورة، ويستبعد الصور المكررة في نفس الإعلان أو المعروضة في إعلانات سابقة.", "Perceptual Image Hashing: hashes each photo to detect and eliminate duplicate or twin images automatically."])}</li>
    <li>${T(lang, ["سقف 15 صورة وصورة الغلاف: الحد الأقصى لكل وحدة هو 15 صورة. الصورة الأولى تصبح تلقائياً هي صورة الغلاف التسويقية للعملاء، ويمكنك تقديم أو تأخير أي صورة بأزرار (↑ / ↓).", "15-Photo Ceiling & Cover: maximum 15 photos per listing. The first image serves as the cover photo, with quick reordering controls (↑ / ↓)."])}</li>
  </ul>
  ${shot("guide/import-chat-03-photos-matching.png", T(lang, ["معرض ربط صور الواتساب بالعقارات وضبط الغلاف ومنع الصور المكررة", "Matched photo gallery with cover selection and perceptual hash duplicate filtering"]))}
</section>

<section class="card" id="chat-assign">
  <h2>👤 ${T(lang, ["الخطوة 4: حل النزاعات وتخصيص البروكر وقاعدة حماية رقم المالك", "Step 4: Conflict Resolution, Broker Assignment & Owner Contact Security"])}</h2>
  <p>${T(lang, [
    "قبل اعتماد حفظ الوحدات في المخزون، يضمن النظام التحقق من ملكية البيانات وحماية سرية الاتصال:",
    "Before finalizing intake, the system enforces broker accountability and strict contact privacy:"
  ])}</p>

  <div class="callout-box alert">
    <strong style="color: #e03131;">🔒 قاعدة أمان جوهرية: رقم مرسل الواتساب ليس رقم المالك!</strong>
    <p style="margin: 4px 0 0; font-size: 12px; color: #4c596f;">
      ${T(lang, [
        "رقم تليفون الراسل في جروب الواتساب يُحفظ فقط في خانة الملاحظات كمرجع للمصدر، ولا يتم تعيينه أبداً كرقم مالك الوحدة. يجب استخراج رقم المالك الحقيقي من نص الإعلان أو كتابته يدوياً لحماية خصوصية وسرية الشركة.",
        "The WhatsApp sender's phone number is saved strictly in the notes as an internal source reference and is NEVER assigned as the unit owner's phone. True owner contacts must be extracted or entered manually."
      ])}
    </p>
  </div>

  <ul>
    <li>${T(lang, ["حل تعارض الوحدات المتشابهة: إذا كان الإعلان يطابق وحدة سابقة (P13)، يتيح لك النظام دمج الصور والأسعار الجديدة في الوحدة القديمة أو إنشاء كود جديد.", "Conflict Resolution: if an ad matches an existing property (P13), choose between merging new photos/price or creating a fresh code."])}</li>
    <li>${T(lang, ["تخصيص البروكر المسئول: يتم إسناد الوحدات المعتمدة إلى حسابك أو إلى البروكر الذي تحدده ليتولى تسويقها ومتابعتها.", "Broker Assignment: newly imported listings are assigned directly to the importing agent or assigned team member."])}</li>
    <li>${T(lang, ["سقف الدفعة: حد أقصى 40 إعلان في الدفعة الواحدة لضمان سرعة المعالجة ودقة المراجعة.", "Batch Ceiling: capped at 40 listings per import session for optimal speed and review accuracy."])}</li>
  </ul>
  ${shot("guide/import-chat-04-conflict-assign.png", T(lang, ["شاشة حل النزاعات وتخصيص البروكر المسئول وحماية رقم المالك", "Conflict resolution, broker assignment selector, and owner phone protection notice"]))}
</section>

<section class="card" id="chat-faq">
  <h2>❓ ${T(lang, ["أسئلة شائعة عن استيراد شات واتساب", "WhatsApp Chat Intake FAQ"])}</h2>
  ${CHAT_FAQ.map(([q, a]) => html`<div class="faq-item" style="margin-bottom: 14px;"><strong>❓ ${T(lang, q)}</strong><p style="margin: 4px 0 0;">${T(lang, a)}</p></div>`)}
</section>`;
}

/** 5. Lead Intake & Management Guide Content (R3 & R4) */
function leadsGuideContent(lang, assets) {
  const shot = (file, caption) => html`
<figure class="guide-shot">
  <img src="${assets.url(file)}" alt="${caption}" loading="lazy">
  <figcaption>📸 ${caption}</figcaption>
</figure>`;

  return html`
<nav class="card row" aria-label="${T(lang, ["محتويات دليل العملاء", "Lead Management Contents"])}">
  <a href="#lead-create">➕ ${T(lang, ["إضافة العميل والتوحيد", "Add & Normalize"])}</a>
  <a href="#lead-guard">🛡️ ${T(lang, ["حماية تعارض الزملاء Q2", "Collision Guard"])}</a>
  <a href="#lead-undo">↩️ ${T(lang, ["تراجع 10 دقائق", "10-Min Undo"])}</a>
  <a href="#lead-pod">👥 ${T(lang, ["فرق العمل المصغرة", "Sub-team Pods"])}</a>
  <a href="#lead-pipeline">📊 ${T(lang, ["لوحة مسار المبيعات", "Pipeline Board"])}</a>
  <a href="#lead-rules">⏰ ${T(lang, ["مواعيد العمل والقواعد", "Cairo Working Hours"])}</a>
  <a href="#lead-away">🌴 ${T(lang, ["إجازات البروكرز", "Broker Away"])}</a>
  <a href="#lead-privacy">🔒 ${T(lang, ["حوكمة الخصوصية PDPL", "PDPL Governance"])}</a>
  <a href="#lead-faq">❓ ${T(lang, ["أسئلة شائعة", "Leads FAQ"])}</a>
</nav>

<!-- القسم الأول: منظور البروكر ورئيس الفريق -->
<section class="card" id="lead-create">
  <h2>➕ ${T(lang, ["الجزء 1: تسجيل العميل الجديد والتوحيد القياسي لرقم الهاتف (E.164)", "Part 1: New Lead Registration & Egyptian Phone Normalization (E.164)"])}</h2>
  <p>${T(lang, [
    "يوفر WehdatHub طرقاً متعددة ومرنة لتسجيل العملاء الجدد: عبر استمارة الموقع (/app/leads/new)، أو مشاركة الشاشة من الموبايل (/app/share)، أو إرسال فويس نوت ورسالة نصية للبوت ليقوم الذكاء الاصطناعي باستخراج بيانات العميل وطلبه تلقائياً.",
    "WehdatHub supports flexible lead intake: web form (/app/leads/new), mobile OS share target (/app/share), or sending a voice note or message to the bot for instant AI parsing."
  ])}</p>

  <div class="guide-example">
    <strong>${T(lang, ["التوحيد القياسي للأرقام المصرية (domain/phone.js):", "Egyptian Phone Normalization Rules:"])}</strong>
    <ul>
      <li>${T(lang, ["تحويل الأرقام العربية والهندية: يتم تحويل الأرقام المكتوبة بالصيغة العربية (٠١٠١٢٣٤٥٦٧٨) تلقائياً إلى أرقام قياسية ASCII.", "Digit Conversion: Arabic-Indic digits (٠-٩) are normalized to standard ASCII digits."])}</li>
      <li>${T(lang, ["التنسيق الدولي E.164: تحويل الأرقام المحلية (01xxxxxxxxx) إلى الصيغة الدولية الموحدة (+201xxxxxxxxx).", "E.164 Normalization: converts local mobile format (01xxxxxxxxx) into international E.164 (+201xxxxxxxxx)."])}</li>
      <li>${T(lang, ["تخزين الأرقام: تُخزن الأرقام في قاعدة البيانات بصيغة الأرقام الدولية بدون علامة زائد (مثال: 201012345678) لتسهيل الربط مع رسائل واتساب والمكالمات.", "Database Storage: saved as international digits without plus (e.g. 201012345678) for instant WhatsApp and dialer integration."])}</li>
      <li>${T(lang, ["عزل مدخل البيانات (Data Entry Barrier): دور مدخل البيانات (data_entry) محظور تماماً من رؤية العملاء أو الوصول لبيانات CRM لحماية سرية عملاء الشركة.", "Data Entry Isolation: data_entry roles are strictly barred from viewing or managing CRM leads (HTTP 403)."])}</li>
    </ul>
  </div>
  ${shot("guide/lead-intake-01-create-normalize.png", T(lang, ["شاشة تسجيل العميل الجديد والتحويل القياسي التلقائي لرقم الهاتف E.164", "New lead registration and automated E.164 phone normalization"]))}
</section>

<section class="card" id="lead-guard">
  <h2>🛡️ ${T(lang, ["حماية تعارض الزملاء الذكية (Colleague Duplicate Guard - Q2)", "Colleague Duplicate Guard & Collision Alerts (Q2)"])}</h2>
  <p>${T(lang, [
    "عندما يحاول بروكر إدخال رقم هاتف مسجل بالفعل مع زميل آخر في نفس الوكالة، يفعل النظام حماية فورية ذكية لمنع التصادم الداخلي وتسريب بيانات العملاء:",
    "When an agent enters a phone number already assigned to a colleague, the system triggers real-time collision guards without leaking client data:"
  ])}</p>

  <ul>
    <li>${T(lang, ["الحماية الفورية أثناء الكتابة (/app/leads/check): بمجرد كتابة الرقم يظهر تنبيه أصفر واضح: «👥 الرقم ده عميل مع زميل. لو حفظت، مديرك هيتبلّغ».", "Real-Time Typing Check (/app/leads/check): warns immediately: '👥 This client is with a colleague. If you save, your manager is alerted.'"]) }</li>
    <li>${T(lang, ["حماية السرية التامة: لا يتم إظهار اسم الزميل الآخر، ولا تفاصيل العميل، ولا وحداته للبروكر السائل لحماية خصوصية الزملاء.", "Strict Data Secrecy: conceals colleague identity, client name, and interaction history from the inquiring broker."])}</li>
    <li>${T(lang, ["إخطار فوري للمدير: يتم تسجيل محاولة الاتصال في سجل الأحداث وإرسال تنبيه عاجل لمدير الوكالة ليتخذ القرار (إما إعادة التعيين أو إبقاء العميل مع زميله).", "Instant Manager Alert: alerts agency managers with full context to reassign or retain the lead."])}</li>
    <li>${T(lang, ["فروق أنماط فرق العمل (Team Styles): في النمط المشترك (Shared) يرى الجميع الليدات للقراءة، بينما في النمط الهرمي (Structured) تُعزل الليدات تماماً وتنشط حماية Q2 الصارمة.", "Team Style Mechanics: Shared mode permits agency-wide read access; Structured mode enforces strict lead isolation and active collision guards."])}</li>
  </ul>
  ${shot("guide/lead-intake-02-duplicate-guard.png", T(lang, ["تنبيه حماية تعارض الزملاء الذكي وإخطار الإدارة دون كشف بيانات العميل", "Smart colleague duplicate collision guard and manager notification"]))}
</section>

<section class="card" id="lead-undo">
  <h2>↩️ ${T(lang, ["مكدس التراجع الفوري عن تعديلات العميل (10-Minute Reversible Undo Stack)", "10-Minute Reversible Lead Mutation Undo Stack"])}</h2>
  <p>${T(lang, [
    "كل إجراء يتخذه البروكر على العميل (تغيير المرحلة، تسجيل اتصال، تحديد موعد متابعة، أو كتابة ملاحظة) محمي بمكدس تراجع فوري لمدة 10 دقائق:",
    "Every lead action (stage transition, call logging, follow-up scheduling, notes) is protected by a 10-minute reversible undo window:"
  ])}</p>

  <ul>
    <li>${T(lang, ["زر تراجع فوري: يظهر شريط أخضر أعلى صفحة العميل يحتوي على زر «↩️ تراجع» مع عداد تنازلي للـ 10 دقائق.", "One-Click Rollback: a prominent green banner with an active 10-minute countdown offers instant rollback."])}</li>
    <li>${T(lang, ["الأحداث القابلة للتراجع (Reversible Events): يشمل التراجع تغيير المرحلة (Stage)، تعيين موعد المتابعة، تسجيل الاتصال، والملاحظات.", "Covered Actions: stage shifts, follow-ups, call logs, notes, and broker assignments."])}</li>
    <li>${T(lang, ["حماية التزامن (Concurrency Guard): إذا أجرى مدير أو زميل تعديلاً أحدث على العميل، يُقفل التراجع تلقائياً (undo_blocked) لمنع الكتابة العكسية غير المتناسقة.", "Concurrency Protection: if subsequent modifications occur on the lead, undo is locked (undo_blocked) to prevent state inconsistency."])}</li>
  </ul>
  ${shot("guide/lead-intake-03-undo-stack.png", T(lang, ["شريط التراجع الفوري عن تعديلات العميل المتاح لمدة 10 دقائق", "10-minute reversible mutation undo banner"]))}
</section>

<section class="card" id="lead-pod">
  <h2>👥 ${T(lang, ["إدارة فرق العمل المصغرة وصلاحيات رئيس الفريق (Sub-team Pod Management)", "Sub-Team Pod Management & Team Lead Reassignment Controls"])}</h2>
  <p>${T(lang, [
    "في باقة الوكالات (Agency Tier - 15 مقعد فأكثر)، يدعم WehdatHub تقسيم الوكالة إلى فرق عمل فرعية مصغرة يقودها رئيس فريق (Team Lead):",
    "In Agency Tier (15+ seats), WehdatHub unlocks sub-team pods managed by Team Leads:"
  ])}</p>

  <ul>
    <li>${T(lang, ["ربط البروكر برئيس فريقه: يرتبط كل بروكر برئيس فريقه في قاعدة البيانات عبر الحقل (brokers.team_lead_id).", "Pod Association: frontline brokers are linked to their team lead via brokers.team_lead_id."])}</li>
    <li>${T(lang, ["صلاحيات رئيس الفريق: يرى رئيس الفريق كل عملاء البروكرز التابعين لفريقه، ويتلقى إشعارات بنشاطهم ومتابعاتهم المتأخرة.", "Team Lead Visibility: oversees all leads assigned to brokers within their pod and receives team alerts."])}</li>
    <li>${T(lang, ["إعادة توزيع العملاء داخل الفريق: يحق لرئيس الفريق إعادة توزيع الليدات بين أعضاء فريقه أو تحويل العميل لنفسه مباشرة دون الحاجة لمدير الوكالة.", "Pod Reassignment: team leads can reassign leads among pod members or to themselves without escalating to agency owners."])}</li>
  </ul>
  ${shot("guide/lead-intake-04-team-lead-pod.png", T(lang, ["شاشة إدارة فريق العمل المصغر وصلاحيات رئيس الفريق لإعادة التوزيع", "Sub-team pod management and team lead reassignment controls"]))}
</section>

<!-- القسم الثاني: منظور مدير ومالك الوكالة -->
<section class="card" id="lead-pipeline">
  <h2>📊 ${T(lang, ["الجزء 2: لوحة مسار المبيعات الشاملة للوكالة وتتبع المراحل والكانبان", "Part 2: Agency Sales Pipeline Funnel & Interactive Kanban Board"])}</h2>
  <p>${T(lang, [
    "يمتلك مديرو الوكالة رؤية شاملة لكافة عملاء وصفقات الشركة من خلال لوحة تحكم تفاعلية (/app/leads و /app/leads/board):",
    "Agency managers maintain complete operational oversight through the pipeline dashboard (/app/leads and /app/leads/board):"
  ])}</p>

  <ul>
    <li>${T(lang, ["مراحل مسار المبيعات المعتمدة: (جديد New ➡ تم التواصل Contacted ➡ مهتم Interested ➡ معاينة Viewing ➡ تفاوض Negotiation ➡ تم البيع Won / ضائعة Lost).", "Standard Pipeline Stages: New ➡ Contacted ➡ Interested ➡ Viewing ➡ Negotiation ➡ Won / Lost."])}</li>
    <li>${T(lang, ["سبب الخسارة الإجباري (Lost Reason): عند تحويل العميل إلى «صفقة ضائعة»، يلزم النظام البروكر باختيار سبب الخسارة (مثل السعر، الموقع، المنافسين) لتحليل أسباب الفقد وتحسين الأداء.", "Mandatory Lost Reason: marking a lead Lost requires specifying the root cause for win/loss analytics."])}</li>
    <li>${T(lang, ["دمج العملاء المكررين (Lead Merge): دمج سجلين لنفس العميل مع تأكيد كتابة كود العميل مرتين، ونقل كافة المكالمات والمتابعات والعروض إلى السجل الأساسي وحذف السجل المكرر.", "Duplicate Merge: consolidates duplicate records after typing reference code twice, migrating history and viewings."])}</li>
    <li>${T(lang, ["محفظة كبار العملاء السرية (VIP Portfolio): يمتلك مالك الوكالة وحده حق تعليم أي عميل أو وحدة كـ «خاصة» (is_private)، لتختفي تماماً عن باقي البروكرز والمديرين.", "Private VIP Portfolio: agency owners can mark leads private (is_private), concealing them from all other staff."])}</li>
  </ul>
  ${shot("guide/lead-manager-01-pipeline-board.png", T(lang, ["لوحة مسار المبيعات الشاملة للوكالة وتتبع مراحل الصفقات والكانبان", "Agency sales pipeline funnel and interactive Kanban board"]))}
</section>

<section class="card" id="lead-rules">
  <h2>⏰ ${T(lang, ["قواعد توزيع العملاء المتقدمة ومواعيد العمل وحساب المهل بتوقيت القاهرة", "Advanced Lead Rules, Cairo Working Hours & Multi-Hop Auto-Reassignment"])}</h2>
  <p>${T(lang, [
    "لضمان سرعة الاستجابة للعملاء الجدد، يطبق WehdatHub نظام قواعد تشغيل متقدم يحسب المهل الزمنية بدقة متناهية:",
    "To maximize speed-to-lead, WehdatHub provides advanced routing rules configured per agency:"
  ])}</p>

  <div class="guide-example">
    <strong>${T(lang, ["آلية حساب مواعيد الاستجابة والتحويل التلقائي:", "Working Hour Deadlines & Multi-Hop Rules:"])}</strong>
    <ul>
      <li>${T(lang, ["حساب المهل بتوقيت القاهرة (Africa/Cairo): تُحسب ساعات العمل ومواعيد الاستجابة حصراً داخل التوقيت الفعلي للقاهرة (مع التكيف مع التوقيت الصيفي والشتوي).", "Cairo Timezone Calculations: response deadlines accrue strictly during agency active hours in Africa/Cairo."])}</li>
      <li>${T(lang, ["إيقاف العداد خارج ساعات العمل: إذا ورد ليد جديد في الساعة 2:00 فجراً وساعات العمل تبدأ 9:00 ص، يتوقف العداد ولا تبدأ مهلة الـ 30 دقيقة إلا في تمام التاسعة صباحاً.", "After-Hours Pause: a lead arriving at 2:00 AM pauses until 9:00 AM opening before the response countdown begins."])}</li>
      <li>${T(lang, ["التحويل التلقائي المتعدد (Multi-hop Auto-reassignment): إذا لم يتواصل البروكر مع العميل قبل انتهاء المهلة، يحول النظام العميل تلقائياً إلى زميل آخر داخل الفريق، ثم لرئيس الفريق، ثم لمدير الوكالة بعد قفزتين (Max 2 jumps).", "Multi-Hop Escalation: uncontacted leads hop via round-robin to a pod peer, then team lead, then managers after max jumps."])}</li>
    </ul>
  </div>
  ${shot("guide/lead-manager-02-rules-schedule.png", T(lang, ["قواعد توزيع العملاء المتقدمة ومواعيد العمل وحساب مهل الاستجابة بتوقيت القاهرة", "Advanced lead routing, Cairo working hours, and response deadlines"]))}
</section>

<section class="card" id="lead-away">
  <h2>🌴 ${T(lang, ["إدارة حالة توفر وإجازات البروكرز (Broker Away Status)", "Broker Availability & Away Status Management"])}</h2>
  <p>${T(lang, [
    "عند قيام بروكر بأخذ إجازة أو عدم توفره للرد، تتيح لوحة الإدارة تسجيل حالته كـ «في إجازة» (Away Until) لضمان عدم ضياع العملاء الجدد:",
    "When an agent takes leave, managers set their status to Away Until to safeguard client response times:"
  ])}</p>

  <ul>
    <li>${T(lang, ["التخطي التلقائي من دور التوزيع: يتم استبعاد البروكر في حالة الإجازة تلقائياً من نظام التوزيع الدائري (Round-Robin) فلا تُسند إليه أي ليدات جديدة أثناء غيابه.", "Round-Robin Bypass: away brokers are automatically skipped during new lead distribution."])}</li>
    <li>${T(lang, ["تحويل تنبيهات المتابعة للمديرين: تنبيهات المتابعات الدورية لعملاء البروكر أثناء إجازته يتم توجيهها لمدير الوكالة للمتابعة المؤقتة.", "Alert Redirection: follow-up reminders on active leads route to managers for temporary handling."])}</li>
    <li>${T(lang, ["إنهاء الإجازة الفوري: يمكن للمدير أو البروكر إنهاء حالة الإجازة بنقرة واحدة ليعود فوراً إلى دور التوزيع واستقبال العملاء.", "Instant Return: status can be restored to Active anytime to re-enter lead rotation."])}</li>
  </ul>
  ${shot("guide/lead-manager-03-broker-away.png", T(lang, ["جدول توفر البروكرز وتسجيل الإجازات واستبعاد البروكر غير المتاح من التوزيع", "Broker availability, Away status, and round-robin bypass"]))}
</section>

<section class="card" id="lead-privacy">
  <h2>🔒 ${T(lang, ["حوكمة الخصوصية وقانون حماية البيانات الشخصية المصري (Egyptian PDPL Compliance)", "Regulatory Privacy Governance & Egyptian PDPL Compliance (Law 151/2020)"])}</h2>
  <p>${T(lang, [
    "يلتزم WehdatHub بأعلى معايير حوكمة البيانات وأحكام قانون حماية البيانات الشخصية المصري رقم 151 لسنة 2020:",
    "WehdatHub fully complies with Egyptian Personal Data Protection Law (Law 151/2020):"
  ])}</p>

  <h3>${T(lang, ["1. تصدير بيانات العميل الكاملة (Client Data Export)", "1. Right to Access & Client Data Export"])}</h3>
  <p>${T(lang, [
    "يحق لمدير الوكالة تصدير ملف كامل ببيانات العميل في أرشيف مضغوط (client-L-XXXX.zip) يحتوي على ملف JSON مقروء آلياً وملف TXT مقروء بشرياً بجميع تعاملاته وروابط الوحدات التي أرسلت له وموافقاته المسجلة.",
    "Managers can export full client records as a ZIP archive containing structured JSON and human-readable TXT covering requests, links, and consent timestamps."
  ])}</p>

  <h3>${T(lang, ["2. الحذف النهائي المشفر بالهاش (Phone-Hashed Permanent Erasure)", "2. Phone-Hashed Permanent Erasure (lead_erasures)"])}</h3>
  <p>${T(lang, [
    "عند طلب العميل مسح بياناته نهائياً، يفتح المدير صفحة العميل ويختار «مسح نهائي» مع إدخال آخر 4 أرقام من موبايل العميل (تأكيد أمني). يقوم النظام بحذف السجل نهائياً وتشفير رقم الهاتف بواسطة خوارزمية HMAC-SHA256 وتخزينه في جدول lead_erasures. إذا حاول أي بروكر إدخال نفس الرقم مستقبلاً، يحذره النظام فوراً بأن العميل طلب سابقاً حذف بياناته.",
    "Upon deletion requests, managers confirm the action by typing the client's last 4 phone digits. The record is permanently deleted and the phone is hashed with HMAC-SHA256 into lead_erasures. Re-intake alerts that the client previously requested erasure."
  ])}</p>

  <h3>${T(lang, ["3. دورة تطهير الركود بعد 18 شهراً (18-Month Inactivity Purge)", "3. 18-Month Inactivity Retention Sweep"])}</h3>
  <p>${T(lang, [
    "يطبق النظام دورة تنظيف دورية (retentionSweep) كل 6 ساعات تبحث عن أي عميل لم يُسجل عليه أي نشاط أو اتصال منذ 18 شهراً كاملاً. يرسل النظام إخطاراً يومياً للمدير قبل الحذف بـ 30 يوماً، ثم يتم مسح السجلات الخاملة تلقائياً امتثالاً للقانون.",
    "Automated sweep cleans leads with zero touchpoints for 18 months, dispatching daily advance warnings to managers 30 days prior."
  ])}</p>
  ${shot("guide/lead-manager-04-pdpl-governance.png", T(lang, ["حوكمة الخصوصية وقانون حماية البيانات المصري والمسح المشفر وتطهير 18 شهراً", "PDPL privacy governance, phone-hashed erasure, and 18-month inactivity purge"]))}
</section>

<section class="card" id="lead-faq">
  <h2>❓ ${T(lang, ["أسئلة شائعة عن إدارة العملاء ومسار المبيعات", "Lead Management FAQ"])}</h2>
  ${LEADS_FAQ.map(([q, a]) => html`<div class="faq-item" style="margin-bottom: 14px;"><strong>❓ ${T(lang, q)}</strong><p style="margin: 4px 0 0;">${T(lang, a)}</p></div>`)}
</section>`;
}

function guidePage(lang, broker, assets, activeTab = 0) {
  const platformTabs = [
    [
      T(lang, ["📱 بوت تيليجرام والأوامر", "📱 Telegram Bot & Commands"]),
      telegramGuideContent(lang, broker)
    ],
    [
      T(lang, ["🏠 الوحدات والبحث", "🏠 Units & Search"]),
      webGuideContent(lang, assets)
    ],
    [
      T(lang, ["📊 إكسيل الوحدات", "📊 Excel Import"]),
      excelGuideContent(lang, assets)
    ],
    [
      T(lang, ["💬 شات واتساب", "💬 WhatsApp Intake"]),
      chatGuideContent(lang, assets)
    ],
    [
      T(lang, ["👥 إدارة العملاء (CRM)", "👥 Lead Intake & Management"]),
      leadsGuideContent(lang, assets)
    ]
  ];

  return html`
<h1>📘 ${T(lang, ["دليل سريع", "Quick guide"])}</h1>
<p class="muted">${T(lang, [
  "اختر القسم الذي تريد استعراضه: دليل الموقع والوحدات، استيراد شيتات الإكسيل، سحب شات واتساب، إدارة العملاء ومسار المبيعات، أو بوت تيليجرام.",
  "Choose your guide: Website & Units, Excel Import, WhatsApp Chat Intake, CRM & Lead Management, or Telegram Bot Commands."
])}</p>
${tabs("guide_platform_tab", platformTabs, { open: activeTab, cls: "guide-tabs" })}`;
}

function register(web, { page, assets }) {
  web.get("/guide", (req, res) => {
    let activeTab = 0;
    const t = req.query.tab;
    if (t === "units" || t === "web" || t === "1") activeTab = 1;
    else if (t === "excel" || t === "2") activeTab = 2;
    else if (t === "chat" || t === "3") activeTab = 3;
    else if (t === "leads" || t === "crm" || t === "4") activeTab = 4;

    return page(req, res, {
      title: T(req.lang, ["دليل سريع", "Quick guide"]),
      langSwitch: true,
      body: guidePage(req.lang, req.session?.broker || null, assets, activeTab)
    });
  });
}

module.exports = { register, SECTIONS, FAQ };
