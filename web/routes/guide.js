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
  [["ليه تيليجرام مش واتساب؟", "Why Telegram and not WhatsApp?"], ["تيليجرام بيوصلك التنبيهات، وتقدر تستقبلها كمان على الموقع والتطبيق. واتساب للتواصل مع العملاء.", "You can get alerts on Telegram, the website and the phone app. WhatsApp is for talking to clients."]],
  [["الموقع بطيء أول ما بفتحه.", "The website is slow the first time I open it."], ["في فترة التجربة السيرفر بينام لما محدش بيستخدمه، وأول فتحة ممكن تاخد دقيقة.", "During the trial the server sleeps when nobody uses it, so the first load can take up to a minute."]]
];

const WEB_FAQ = [
  [["هل العميل يستطيع رؤية رقم تليفون المالك؟", "Will clients ever see the owner's phone number?"], ["لا نهائياً. روابط العملاء التي ترسلها تعرض فقط صور الوحدة والمواصفات وسعر البيع دون أي أرقام هواتف أو بيانات داخلية.", "Never. Client links that you share only display property photos, specifications and pricing. Internal notes and owner contacts remain strictly private to your agency."]],
  [["ماذا أفعل إذا لم أجد اسم الكمبوند في القائمة؟", "What if I don't find the compound in the dropdown?"], ["اكتب اسم الكمبوند واضغط عليه وسيتم تسجيله ككمبوند جديد تلقائياً في حساب وكالتك.", "Simply type the compound name and press Enter. The system will register it as a new compound in your agency account automatically."]],
  [["ماذا يعني التنبيه باللون الأصفر عند الحفظ؟", "What does the yellow warning box mean?"], ["هذا تنبيه ذكي لتذكيرك في حال وجود وحدة أخرى مسجلة بنفس السعر والمساحة، لتجنب تكرار إدخال نفس الوحدة عن طريق الخطأ.", "It is a smart check alerting you if another colleague already added the same property in your inventory, preventing duplicate listings."]],
  [["هل يمكنني تعديل الوحدة لاحقاً بعد حفظها؟", "Can I edit unit details later after saving?"], ["نعم، في أي وقت يمكنك الدخول على صفحة الوحدة والضغط على «✏️ تعديل» وتحديث أي بيانات أو صور.", "Yes, anytime! Simply open the unit card and click \"✏️ Edit\" to update prices, photos, or status."]]
];

const EXCEL_FAQ = [
  [["هل يستهلك استيراد الإكسيل من رصيد الذكاء الاصطناعي؟", "Does Excel import consume AI credits?"], ["لا نهائياً. قراءة ملفات الإكسيل (.xlsx و .csv) ومطابقة الأعمدة مجانية بالكامل داخل المتصفح ولا تخصم أي رصيد من باقة شركتك.", "Never. Reading Excel files (.xlsx and .csv) and column matching is completely free in the browser and does not consume any AI credits."]],
  [["ماذا يحدث إذا كان الملف يحتوي على شيتات فارغة؟", "What happens if the file contains empty sheets?"], ["يتخطى النظام الشيتات الفارغة تلقائياً بدون إيقاف باقي الشيتات، ويوضح ذلك في تقرير المعاينة.", "The system automatically skips empty sheets without stopping the rest of the file, showing them clearly in the preview report."]],
  [["هل يمكنني التراجع عن عملية الاستيراد بعد تطبيقها؟", "Can I undo an import after saving?"], ["نعم، يمكنك التراجع عن أي عملية استيراد خلال 30 يوماً بنقرة واحدة، واستعادة الأسعار السابقة أو حذف الوحدات التي تمت إضافتها.", "Yes, you can undo any import within 30 days with a single click, restoring previous prices or deleting newly added listings."]],
  [["ما هي الأعمدة الأساسية التي لا يمكن الاستيراد بدونها؟", "Which columns are required for Excel import?"], ["الأعمدة الأساسية الستة هي: الكمبوند، نوع الوحدة، الغرض (بيع أو إيجار)، السعر الإجمالي، المساحة، ورقم تليفون المالك.", "The 6 essential columns are: Compound, Property Type, Purpose (Sale/Rent), Price, Area, and Owner Phone."]]
];

const CHAT_FAQ = [
  [["هل يتم حفظ رقم مرسل رسالة الواتساب كرقم لمالك الوحدة؟", "Is the WhatsApp sender's phone saved as the owner's phone?"], ["لا نهائياً. رقم الراسل في الجروب يُحفظ فقط في الملاحظات كمرجع لمصدر العقار، ولا يُسجل كرقم للمالك حفاظاً على خصوصيتك وسرية بياناتك.", "Never. The group sender's number is recorded only in internal notes as a source reference, and is never set as the unit owner's phone to protect your privacy."]],
  [["كم عدد الصور المسموح بها لكل عقار؟", "How many photos are allowed per listing?"], ["يمكنك إضافة حتى 15 صورة لكل وحدة. الصورة الأولى تصبح تلقائياً صورة الغلاف، ويمكنك تقديم أو تأخير أي صورة بسهولة.", "You can attach up to 15 photos per listing. The first image becomes the cover photo, and you can easily reorder or delete images."]],
  [["ماذا يحدث لرسائل طلبات الشراء داخل الشات؟", "What happens to buyer requests in the chat?"], ["الرسائل التي تبدأ بكلمات طلب (مثل «مطلوب» أو «محتاج شقة») يتم استبعادها تلقائياً حتى لا تدخل في مخزون العقارات المعروضة.", "Messages starting with buyer requests (like 'wanted' or 'looking for') are automatically filtered out so they never clutter your property inventory."]],
  [["من يملك صلاحية استيراد شات الواتساب في الشركة؟", "Who has permission to import WhatsApp chats?"] , ["خاصية استيراد الشات متاحة لمديري الوكالة ولمسؤولي إدخال البيانات، ومغلقة أمام باقي البروكرز للحفاظ على تنظيم المخزون.", "WhatsApp chat intake is available to managers and data entry staff to keep inventory organized."]]
];

const LEADS_FAQ = [
  [["ماذا يحدث لو سجلت رقم عميل موجود مسبقاً مع زميلي في الشركة؟", "What happens if I enter a client already with a colleague?"], ["يظهر لك تنبيه أصفر فوري بأن الرقم مسجل مع زميل. للحفاظ على سرية العمل وخصوصية الزملاء، لن تظهر لك بيانات العميل أو اسم زميلك، ويتم إخطار المدير للتنسيق بينكما.", "You get an immediate yellow alert that the client is already with a colleague. To protect teamwork and privacy, you won't see your colleague's name or client details, and the manager is notified to coordinate."]],
  [["كم مدة التراجع المتاحة لو عدلت مرحلة عميل أو بياناته بالخطأ؟", "How long do I have to undo a change on a client?"], ["يمكنك التراجع الفوري عن أي إجراء (تغيير المرحلة، تسجيل مكالمة، موعد متابعة) خلال 10 دقائق كاملة عبر زر «↩️ تراجع» الأخضر في أعلى الصفحة.", "You can immediately undo any action (stage change, call log, follow-up date) within 10 full minutes using the green '↩️ Undo' button at the top of the page."]],
  [["كيف يتم حساب وقت الرد على العميل خارج مواعيد العمل؟", "How is response time calculated outside working hours?"], ["عداد مهلة الرد يعمل فقط أثناء ساعات العمل الرسمية بتوقيت القاهرة (مثلاً من 9 صباحاً إلى 9 مساءً). لو ورد عميل في منتصف الليل، يبدأ العداد في التاسعة صباحاً.", "The response timer runs strictly during official working hours in Cairo time (e.g. 9:00 AM to 9:00 PM). If a lead arrives overnight, the timer begins at 9:00 AM."]],
  [["إذا طلب العميل مسح بياناته نهائياً، كيف نتصرف؟", "What if a client asks us to delete their data?"] , ["يفتح المدير صفحة العميل ويختار «مسح نهائي» ويؤكد العملية. يتم حذف السجل بالكامل، وينبهك النظام تلقائياً إذا حاول أي زميل تسجيل نفس الرقم مستقبلاً.", "A manager opens the client page, chooses 'Erase for good', and confirms. The record is permanently deleted, and the system alerts your team if anyone tries to re-enter the same number later."]]
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
    <li>${T(lang, ["نوع العرض: اضغط على «بيع» (أو «إيجار» لوحدة معروضة للإيجار).", "Offer Type: click \"Sale\" or \"Rent\"."])}</li>
    <li>${T(lang, ["نوع الوحدة: اختر نوع العقار (مثال: «شقة» أو فيلا، تاون هاوس، دوبلكس...).", "Unit Type: select the property category (e.g., Apartment, Villa, Townhouse...)."])}</li>
    <li>${T(lang, ["صندوق المكان والمميزات الموحد: اكتب اسم الكمبوند أو المنطقة (مثال: هايد بارك)، واضغط على الاقتراح الذكي ليتحول إلى بطاقة مسار زرقاء.", "Unified Place Box: type the compound name (e.g. Hyde Park) and pick the matching suggestion to lock its geographic hierarchy."])}</li>
    <li>${T(lang, ["المميزات: اكتب أي ميزة إضافية في نفس الخانة (مثال: غرفة مربية، بحري) لتضاف كرقاقة مميزات.", "Features: type additional perks (e.g., Nanny room, Sea view) in the same box to add them as badges."])}</li>
    <li>${T(lang, ["اضغط زر «التالي» الأزرق في أسفل الشاشة.", "Click the blue \"Next\" button at the bottom."])}</li>
  </ul>
  ${shot("guide/add-unit-01-place-features.png", T(lang, ["الخطوة 1: نوع الوحدة، الكمبوند، وصندوق المكان والمميزات الموحد", "Step 1: Unit type, compound, and the unified place & feature box"]))}

  <h3>${T(lang, ["الخطوة 2 من 4: المساحة والسعر", "Step 2 of 4: Size and Price"])}</h3>
  <ul>
    <li>${T(lang, ["المساحة: اكتب المساحة الإجمالية بالأرقام (مثال: 165).", "Area: enter the total square meters in numbers (e.g., 165)."])}</li>
    <li>${T(lang, ["الغرف والحمامات والدور: اضغط على أزرار الأرقام بنقرة واحدة (مثال: 3 غرف، 2 حمام، دور 3).", "Rooms & Floor: click the buttons for bedrooms (3), bathrooms (2), and floor level (3)."])}</li>
    <li>${T(lang, ["التشطيب والفرش: اختر حالة التشطيب (تشطيب كامل) وحالة الفرش (بدون فرش).", "Finishing & Furnishing: select Finishing (Fully Finished) and Furnishing (Unfurnished)."])}</li>
    <li>${T(lang, ["السعر والعملة: اكتب إجمالي السعر (5500000) وتأكد من اختيار العملة (EGP أو USD).", "Price & Currency: enter the total amount (5500000) and pick the currency (EGP or USD)."])}</li>
    <li>${T(lang, ["اضغط زر «التالي».", "Click the \"Next\" button."])}</li>
  </ul>
  ${shot("guide/add-unit-02-size-price.png", T(lang, ["الخطوة 2: تحديد المساحة، الغرف، الحمامات، التشطيب، والسعر", "Step 2: Entering area, bedrooms, bathrooms, finishing, and asking price"]))}

  <h3>${T(lang, ["الخطوة 3 من 4: الاستلام ونظام السداد", "Step 3 of 4: Delivery and Payment Terms"])}</h3>
  <ul>
    <li>${T(lang, ["موعد الاستلام: إذا كانت الوحدة جاهزة، ضع علامة صح داخل مربع «استلام فوري». إذا كانت تحت الإنشاء، حدد سنة الاستلام والربع السنوي.", "Delivery: if the unit is finished, tick \"Immediate Delivery / Ready to move\"; otherwise specify delivery year & quarter."])}</li>
    <li>${T(lang, ["طريقة الدفع: في حالة الكاش، اكتب المبلغ في خانة «المدفوع كاش المطلوب» (5500000) واترك الأقساط فارغة.", "Payment: for cash deals, enter full price in \"Required Cash Amount\" and leave installments empty."])}</li>
    <li>${T(lang, ["في حالة التقسيط: حدد المقدم المطلوب، المتبقي من الأقساط، قيمة القسط ونظامه (شهري/ربع سنوي)، وتاريخ آخر قسط.", "For installment plans: enter cash down payment, remaining installments, installment value & frequency, and final date."])}</li>
    <li>${T(lang, ["اضغط زر «التالي».", "Click the \"Next\" button."])}</li>
  </ul>
  ${shot("guide/add-unit-03-delivery-payment.png", T(lang, ["الخطوة 3: تحديد حالة الاستلام الفوري وتفاصيل الدفع كاش أو أقساط", "Step 3: Specifying delivery status and cash or installment schedule"]))}

  <h3>${T(lang, ["الخطوة 4 من 4: المالك، الصور، والمراجعة قبل الحفظ", "Step 4 of 4: Owner Details, Photos & Pre-Save Review"])}</h3>
  <ul>
    <li>${T(lang, ["بيانات المالك: اكتب اسم المالك (محمد أحمد) ورقم الموبايل (01012345678). 🔒 تنبيه: رقم المالك سري ومحمي تماماً ولن يظهر للعملاء أبداً.", "Owner Information: enter owner name and mobile (01012345678). 🔒 Note: owner details are strictly private and never exposed to clients."])}</li>
    <li>${T(lang, ["الوصف التسويقي: اضغط على زرار «✨ اكتب الوصف من بيانات الوحدة» ليقوم الموقع تلقائياً بصياغة رسالة تسويقية ممتازة للعملاء.", "Marketing Description: click \"✨ Write description from unit data\" to automatically generate an attractive summary for clients."])}</li>
    <li>${T(lang, ["الصور: اضغط على مربع الصور لاختيار حتى 15 صورة من جهازك، أو اسحب الصور مباشرة للمربع.", "Photos: click the photo box to select up to 15 property images, or drag & drop image files."])}</li>
    <li>${T(lang, ["المراجعة: اضغط «📋 مراجعة قبل الحفظ» للتأكد من اكتمال كافة البيانات.", "Review: click \"📋 Review before saving\" to double-check all fields."])}</li>
    <li>${T(lang, ["الحفظ النهائي: اضغط زر «✅ حفظ» الأخضر. مبروك! تم حفظ الوحدة وتوليد كود مميز لها (مثل HP301).", "Save: click the green \"✅ Save\" button. Congratulations! Your unit is saved with its unique code (e.g., HP301)."])}</li>
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
    <li>${T(lang, ["تحديث أي بيان مباشرة (مثل السعر أو حالة الوحدة إلى مباعة). ينبهك النظام إذا كان زميل يعدل نفس الوحدة في نفس الوقت لمنع التضارب.", "Update any field directly (like price or marking as sold). The system alerts you if a colleague is editing the same unit at the same time to prevent conflicts."])}</li>
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
    <li>${T(lang, ["تنبيه أصفر ذكي ينبهك في حال وجود وحدة مسجلة مسبقاً بنفس المواصفات لتجنب التكرار.", "Smart duplicate alert flags existing properties matching specs before saving."])}</li>
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
  <a href="#excel-mapping">🔤 ${T(lang, ["مطابقة الأعمدة", "Column Matching"])}</a>
  <a href="#excel-diff">🔍 ${T(lang, ["مراجعة التغييرات", "Review Changes"])}</a>
  <a href="#excel-rules">🛡️ ${T(lang, ["حماية التكرار والتراجع", "Duplicates & Undo"])}</a>
  <a href="#excel-faq">❓ ${T(lang, ["أسئلة شائعة", "Excel FAQ"])}</a>
</nav>

<section class="card" id="excel-upload">
  <h2>📑 ${T(lang, ["الخطوة 1: رفع ملف الإكسيل والتعامل مع الشيتات المتعددة", "Step 1: Uploading Excel Workbooks & Multiple Sheets"])}</h2>
  <p>${T(lang, [
    "تتيح لك ميزة استيراد الإكسيل تحميل محفظة عقاراتك بالكامل في ثوانٍ. تتم قراءة الملفات في متصفحك مباشرة بسرعة وأمان ودون استهلاك أي رصيد من رصيد الذكاء الاصطناعي لشركتك.",
    "Excel import lets you upload your entire property inventory in seconds. Files are read directly in your browser quickly and safely, without using any AI credits."
  ])}</p>

  <div class="guide-example">
    <strong>${T(lang, ["إرشادات رفع الملف والشيتات:", "File & Sheet Guidelines:"])}</strong>
    <ul>
      <li>${T(lang, ["الصيغ المدعومة: يقبل النظام ملفات .xlsx وملفات .csv بحجم يصل إلى 5 ميجابايت.", "Supported Formats: accepts .xlsx and .csv files up to 5 MB."])}</li>
      <li>${T(lang, ["الشيتات المتعددة: يمكنك رفع ملفات ضخمة تحتوي على عشرات الشيتات وآلاف الوحدات دفعة واحدة.", "Multiple Sheets: you can upload large files containing multiple sheets and thousands of properties at once."])}</li>
      <li>${T(lang, ["تخطي الشيتات الفارغة تلقائياً: الشيتات التي لا تحتوي على بيانات يتخطاها النظام تلقائياً ويستكمل باقي الملف بسلاسة.", "Skipping Empty Sheets: empty sheets are skipped automatically while active sheets proceed smoothly."])}</li>
      <li>${T(lang, ["اسم الكمبوند من اسم الشيت: لو الشيت مخصص لكمبوند معين ولا يوجد عمود لاسم الكمبوند، يعتمد النظام اسم الشيت تلقائياً كاسم للكمبوند.", "Compound Name from Sheet: if a sheet is dedicated to a compound without a compound column, the tab name is used automatically."])}</li>
      <li>${T(lang, ["الصلاحيات: ميزة استيراد الإكسيل متاحة لمديري الوكالة ومالكها.", "Permissions: Excel import is available to agency managers and owners."])}</li>
    </ul>
  </div>
  ${shot("guide/import-excel-01-upload-sheets.png", T(lang, ["منطقة رفع ملف الإكسيل واختيار الشيتات واستبعاد الشيتات الفارغة", "Excel upload dropzone, multi-sheet selection, and empty sheet exclusion"]))}
</section>

<section class="card" id="excel-mapping">
  <h2>🔤 ${T(lang, ["الخطوة 2: التعرف التلقائي على الأعمدة وتصحيح العناوين", "Step 2: Checking Columns & Smart Header Matching"])}</h2>
  <p>${T(lang, [
    "يتعرف النظام تلقائياً على عناوين الأعمدة في ملفك ويربطها بالخانات المناسبة، حتى لو كانت الكلمات تحتوي على اختصارات أو أخطاء إملائية شائعة.",
    "The system automatically detects column headers in your file and pairs them with the right fields, even with common typos or abbreviations."
  ])}</p>

  <h3>${T(lang, ["الأعمدة الأساسية والمطلوبة", "Required Columns & Essential Fields"])}</h3>
  <ul>
    <li>${T(lang, ["الأعمدة الستة المطلوبة: الكمبوند، نوع الوحدة، الغرض (بيع أو إيجار)، السعر، المساحة، ورقم تليفون المالك.", "6 Essential Columns: Compound, Property Type, Purpose (Sale/Rent), Price, Area, and Owner Phone."])}</li>
    <li>${T(lang, ["فهم الاختصارات والأخطاء: يتعرف النظام تلقائياً على الكلمات الشائعة (مثل descibation أو phone numper) ويربطها بالحقل الصحيح.", "Typo Tolerance: common variations and misspellings are recognized and matched to the right fields."])}</li>
    <li>${T(lang, ["التعديل اليدوي في أي وقت: يمكنك في أي وقت فتح قائمة الأعمدة وتغيير مطابقة أي عمود وإعادة الحساب فوراً قبل الحفظ.", "Manual Adjustment: you can change any column mapping from the dropdowns at any time before proceeding."])}</li>
  </ul>
  ${shot("guide/import-excel-02-mapping-headers.png", T(lang, ["شاشة مطابقة الأعمدة والتعرف الذكي على الحقول وتصحيح الأخطاء", "Column mapping interface with smart header detection and typo correction"]))}
</section>

<section class="card" id="excel-diff">
  <h2>🔍 ${T(lang, ["الخطوة 3: مراجعة التغييرات والتعديلات قبل الحفظ", "Step 3: Reviewing Changes & Classifications Before Saving"])}</h2>
  <p>${T(lang, [
    "قبل اعتماد أي تعديل أو حفظه، يعرض لك النظام شاشة معاينة واضحة تصنف كل عقار في ملفك بالألوان لسهولة المراجعة:",
    "Before saving any changes, the preview screen classifies every property with intuitive color coding:"
  ])}</p>

  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px;">
    <div class="notice ok">
      <strong>🆕 ${T(lang, ["جديدة:", "New:"])}</strong>
      <p style="margin: 4px 0 0; font-size: 12px;">${T(lang, ["وحدة جديدة لم تسجل من قبل. سيتم إنشاؤها وتوليد كود خاص بها.", "Brand new listing. Will be added to your inventory with a unique code."])}</p>
    </div>
    <div class="notice" style="border-inline-start-color: #1971c2;">
      <strong>✏️ ${T(lang, ["تعديل:", "Updated:"])}</strong>
      <p style="margin: 4px 0 0; font-size: 12px;">${T(lang, ["وحدة مسجلة بالفعل حدث تغيير في سعرها أو تفاصيلها. يوضح لك النظام التغيير بوضوح: السعر القديم ➡ السعر الجديد.", "Existing listing with detected updates, showing old vs new values clearly."])}</p>
    </div>
    <div class="notice warn">
      <strong>⚠️ ${T(lang, ["للمراجعة:", "Review:"])}</strong>
      <p style="margin: 4px 0 0; font-size: 12px;">${T(lang, ["وحدة تبدو مشابهة جداً لوحدة قائمة. يتيح لك النظام إما تحديث الوحدة القديمة أو إضافتها كوحدة جديدة.", "Unit very similar to an existing one. You can choose whether to update the existing unit or add as new."])}</p>
    </div>
    <div class="notice">
      <strong>✔️ ${T(lang, ["متطابقة:", "Unchanged:"])}</strong>
      <p style="margin: 4px 0 0; font-size: 12px;">${T(lang, ["بيانات مطابقة تماماً للمسجل عندك، يتم تخطيها تلقائياً لتوفير الوقت.", "Identical to current inventory records. Safely skipped by default."])}</p>
    </div>
  </div>
  ${shot("guide/import-excel-03-diff-preview.png", T(lang, ["شاشة معاينة الفروق والتعديلات وتصنيف الصفوف قبل الحفظ", "Diff preview screen displaying row classifications and inline changes"]))}
</section>

<section class="card" id="excel-rules">
  <h2>🛡️ ${T(lang, ["الخطوة 4: حماية المخزون من التكرار وسعة الباقة والتراجع", "Step 4: Duplicate Protection, Plan Capacity & 30-Day Undo"])}</h2>
  <p>${T(lang, [
    "للحفاظ على نظافة بيانات شركتك وحمايتها، يطبق WehdatHub ضوابط حماية تلقائية تضمن راحة بالك:",
    "To protect your agency's inventory integrity, WehdatHub enforces automatic safeguards:"
  ])}</p>

  <h3>${T(lang, ["1. الحماية الذكية من تكرار الوحدات", "1. Smart Duplicate Listing Protection"])}</h3>
  <p>${T(lang, [
    "يقارن النظام الكمبوند ونوع العقار والغرف والمساحة والسعر. في حال وجود وحدة مشابهة، ينبهك النظام ويوجهها لقسم «المراجعة» لتتخذ القرار الأنسب وتتجنب التكرار العشوائي.",
    "Checks compound, property type, bedrooms, area, and price. If a similar unit exists, it is flagged under Review so you can choose the best action without cluttering inventory."
  ])}</p>

  <h3>${T(lang, ["2. فحص سعة باقة الوكالة", "2. Agency Plan Capacity Check"])}</h3>
  <p>${T(lang, [
    "يتأكد النظام تلقائياً من عدد الوحدات المتبقية في باقة شركتك قبل الحفظ. إذا تجاوز الملف السعة المتاحة، يحفظ النظام الوحدات حتى اكتمال السعة ويحتفظ بباقي الصفوف بأمان لتتمكن من إضافتها لاحقاً.",
    "Automatically checks remaining unit capacity on your plan. If an import exceeds quota, units up to capacity are saved while surplus rows are safely held without data loss."
  ])}</p>

  <h3>${T(lang, ["3. التراجع بنقرة واحدة خلال 30 يوماً", "3. 30-Day One-Click Undo"])}</h3>
  <p>${T(lang, [
    "يمكنك التراجع عن أي عملية استيراد إكسيل بالكامل خلال 30 يوماً. يتم حذف الوحدات التي تمت إضافتها واستعادة الأسعار والتفاصيل السابقة للوحدات المحدثة بنقرة زر واحدة.",
    "Any applied import can be fully rolled back within 30 days, deleting newly added units and restoring prior prices and details with a single click."
  ])}</p>
  ${shot("guide/import-excel-04-rules-dedup.png", T(lang, ["قواعد منع التكرار وفحص سعة الباقة وإمكانية التراجع الكامل", "Duplicate rules, quota checks, and 30-day reversible undo"]))}
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
  <a href="#chat-upload">📦 ${T(lang, ["رفع الشات والفترة", "Upload & Filters"])}</a>
  <a href="#chat-extract">📝 ${T(lang, ["استخراج الإعلانات", "Extraction"])}</a>
  <a href="#chat-photos">📸 ${T(lang, ["ربط وترتيب الصور", "Photos & Order"])}</a>
  <a href="#chat-assign">👤 ${T(lang, ["التخصيص والسرية", "Assignment & Privacy"])}</a>
  <a href="#chat-faq">❓ ${T(lang, ["أسئلة شائعة", "Chat FAQ"])}</a>
</nav>

<section class="card" id="chat-upload">
  <h2>📦 ${T(lang, ["الخطوة 1: رفع أرشيف الشات واختيار الفترة الزمنية", "Step 1: Uploading WhatsApp Export Archives & Date Range Filtering"])}</h2>
  <p>${T(lang, [
    "تتيح لك هذه الميزة سحب إعلانات العقارات من جروبات ومحادثات واتساب وتحويلها إلى وحدات منظمة مع صورها بنقرة واحدة، دون الحاجة لنقلها يدوياً إعلاناً بإعلان.",
    "WhatsApp chat intake converts forwarded listings and group messages into structured property cards complete with photos in one click, without manual typing."
  ])}</p>

  <div class="guide-example">
    <strong>${T(lang, ["إرشادات رفع الشات والفلترة الزمنية:", "Upload Guidelines & Date Filters:"])}</strong>
    <ul>
      <li>${T(lang, ["معالجة سريعة وآمنة في المتصفح: يتم فك ضغط ملف .zip وقراءة الصور وسجل المحادثة مباشرة في متصفحك بسرعة فائقة وبكل أمان.", "Fast & Secure In-Browser Processing: zip files, photos, and messages are processed directly in your browser quickly and securely."])}</li>
      <li>${T(lang, ["استهلاك الذكاء الاصطناعي: مجاني تماماً! لا تستهلك هذه الميزة أي رصيد من باقة الذكاء الاصطناعي لشركتك.", "AI Credit Usage: Completely free! This feature uses zero AI credits from your agency plan."])}</li>
      <li>${T(lang, ["خيارات الفترة الزمنية: يمكنك تحديد نطاق الإعلانات: آخر 7 أيام، آخر 30 يوماً، كل الشات، أو «منذ آخر استيراد» لقراءة الإعلانات الجديدة فقط وتجنب الإعلانات السابقة.", "Date Range Controls: filter by Last 7 days, Last 30 days, All time, or 'Since last import' to process only new listings."])}</li>
      <li>${T(lang, ["صلاحية الاستيراد: متاحة لمديري الوكالة ولمسؤولي إدخال البيانات.", "Permissions: available to agency managers and data entry staff."])}</li>
    </ul>
  </div>
  ${shot("guide/import-chat-01-upload-filters.png", T(lang, ["شاشة رفع أرشيف شات واتساب وتحديد النطاق الزمني", "WhatsApp chat zip upload interface and date range controls"]))}
</section>

<section class="card" id="chat-extract">
  <h2>📝 ${T(lang, ["الخطوة 2: استخراج الإعلانات وتصفية طلبات الشراء", "Step 2: Listing Extraction & Filtering Out Buyer Requests"])}</h2>
  <p>${T(lang, [
    "يقوم النظام بقراءة نصوص المحادثة لتمييز الوحدات الحقيقية المعروضة للبيع أو الإيجار وفصلها عن الأحاديث العامة وطلبات المشترين:",
    "The system analyzes chat messages to extract genuine listings while discarding casual chat and buyer requests:"
  ])}</p>

  <ul>
    <li>${T(lang, ["تمييز الإعلانات المكتملة: يتعرف النظام على الرسائل التي تحتوي على تفاصيل عقار حقيقي، مثل السعر والمساحة والكمبوند ونوع الوحدة.", "Identifying Real Listings: detects messages with property details like price, area, compound, and unit type."])}</li>
    <li>${T(lang, ["استبعاد طلبات المشترين تلقائياً: الرسائل التي تبدأ بكلمات طلب (مثل: مطلوب، عايز، محتاج، ابحث عن) يتم استبعادها تلقائياً حتى لا تسجل كوحدات بالمخزون.", "Filtering Buyer Requests: buyer inquiries starting with 'looking for', 'wanted', or 'interested in' are automatically filtered out."])}</li>
    <li>${T(lang, ["دعم جميع الهواتف: يدعم النظام ملفات المحادثة المصدرة من أجهزة آيفون (iOS) وأندرويد باللغتين العربية والإنجليزية.", "Cross-Platform Support: seamlessly reads chat exports from both iPhone and Android in Arabic and English."])}</li>
  </ul>
  ${shot("guide/import-chat-02-parse-extract.png", T(lang, ["شاشة استخراج بيانات العقار من رسالة الواتساب واستبعاد طلبات البحث", "Property listing extraction preview and buyer request filtering"]))}
</section>

<section class="card" id="chat-photos">
  <h2>📸 ${T(lang, ["الخطوة 3: ربط الصور بالعقارات واختيار صورة الغلاف", "Step 3: Photo Attachment, Duplicate Filtering & Cover Selection"])}</h2>
  <p>${T(lang, [
    "في مجموعات واتساب، غالباً ما تُرسل الصور في رسائل منفصلة عن النص. يحل النظام هذه المشكلة ويربط الصور بإعلاناتها المناسبة تلقائياً:",
    "In WhatsApp groups, photos often arrive in separate messages from descriptions. The system pairs them automatically:"
  ])}</p>

  <h3>${T(lang, ["قواعد مطابقة وترتيب الصور", "Photo Matching & Ordering Rules"])}</h3>
  <ul>
    <li>${T(lang, ["تجميع الرسائل المتتالية: يجمع النظام الصور والنصوص المرسلة في وقت متقارب من نفس الراسل ويربطها بالعقار المناسب.", "Smart Photo Grouping: pairs photos and text sent around the same time by the same participant with the right listing."])}</li>
    <li>${T(lang, ["فهم إشارات الاتجاه في النص: يتعرف النظام تلقائياً على عبارات مثل «صور فوق» أو «صور تحت» لربط الصور بدقة.", "Direction Cues: understands hints like 'photos above' or 'photos below' to connect images accurately."])}</li>
    <li>${T(lang, ["حذف الصور المكررة تلقائياً: يفحص النظام الصور ويستبعد الصور المكررة في نفس الإعلان أو المعروضة في إعلانات سابقة.", "Automatic Duplicate Filtering: detects and removes duplicate images within the same listing or across previous posts."])}</li>
    <li>${T(lang, ["سقف 15 صورة واختيار الغلاف: الحد الأقصى لكل وحدة هو 15 صورة. الصورة الأولى تصبح تلقائياً هي صورة الغلاف للعملاء، ويمكنك تقديم أو تأخير أي صورة بأزرار (↑ / ↓).", "15-Photo Limit & Cover Selection: maximum 15 photos per listing. The first image serves as the cover photo, with quick reordering controls (↑ / ↓)."])}</li>
  </ul>
  ${shot("guide/import-chat-03-photos-matching.png", T(lang, ["معرض ربط صور الواتساب بالعقارات وضبط الغلاف ومنع الصور المكررة", "Matched photo gallery with cover selection and duplicate filtering"]))}
</section>

<section class="card" id="chat-assign">
  <h2>👤 ${T(lang, ["الخطوة 4: حماية رقم المالك وتخصيص البروكر المسئول", "Step 4: Owner Contact Privacy & Broker Assignment"])}</h2>
  <p>${T(lang, [
    "قبل اعتماد حفظ الوحدات في المخزون، يضمن النظام حماية سرية بياناتك وتنظيم المتابعة بين فريق العمل:",
    "Before finalizing intake, the system enforces broker accountability and strict contact privacy:"
  ])}</p>

  <div class="callout-box alert">
    <strong style="color: #e03131;">🔒 ${T(lang, ["قاعدة أمان أساسية: رقم مرسل الواتساب ليس رقم المالك!", "Key privacy rule: the WhatsApp sender's number is not the owner's number!"])}</strong>
    <p style="margin: 4px 0 0; font-size: 12px; color: #4c596f;">
      ${T(lang, [
        "رقم تليفون الراسل في جروب الواتساب يُحفظ فقط في خانة الملاحظات كمرجع للمصدر، ولا يتم تعيينه أبداً كرقم مالك الوحدة. يجب كتابة رقم المالك الحقيقي من نص الإعلان أو إدخاله يدوياً لحماية خصوصية وسرية الشركة.",
        "The WhatsApp sender's phone number is saved strictly in notes as a source reference and is NEVER assigned as the unit owner's phone. True owner contacts must be taken from the ad text or entered manually."
      ])}
    </p>
  </div>

  <ul>
    <li>${T(lang, ["حل تعارض الوحدات المتشابهة: إذا كان الإعلان يطابق وحدة سابقة، يتيح لك النظام دمج الصور والأسعار الجديدة في الوحدة القديمة أو إنشاء كود جديد.", "Conflict Resolution: if an ad matches an existing property, choose between updating the existing unit or creating a new listing."])}</li>
    <li>${T(lang, ["تخصيص البروكر المسئول: يتم إسناد الوحدات المعتمدة إلى حسابك أو إلى البروكر الذي تحدده ليتولى تسويقها ومتابعتها.", "Broker Assignment: imported listings are assigned directly to you or to the team member you select."])}</li>
    <li>${T(lang, ["دفعات مناسبة للمراجعة: حد أقصى 40 إعلاناً في الدفعة الواحدة لضمان سرعة المعالجة ودقة المراجعة قبل الحفظ.", "Manageable Batches: capped at 40 listings per session for fast, accurate review."])}</li>
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
  <a href="#lead-create">➕ ${T(lang, ["تسجيل العميل", "Add Lead"])}</a>
  <a href="#lead-guard">🛡️ ${T(lang, ["تنبيه تعارض الزملاء", "Colleague Alert"])}</a>
  <a href="#lead-undo">↩️ ${T(lang, ["تراجع 10 دقائق", "10-Min Undo"])}</a>
  <a href="#lead-pod">👥 ${T(lang, ["متابعة فريق العمل", "Team Follow-Up"])}</a>
  <a href="#lead-pipeline">📊 ${T(lang, ["لوحة مسار المبيعات", "Pipeline Board"])}</a>
  <a href="#lead-rules">⏰ ${T(lang, ["مواعيد العمل والرد", "Working Hours"])}</a>
  <a href="#lead-away">🌴 ${T(lang, ["إجازات البروكرز", "Broker Leave"])}</a>
  <a href="#lead-privacy">🔒 ${T(lang, ["خصوصية ومسح البيانات", "Privacy & Erasure"])}</a>
  <a href="#lead-faq">❓ ${T(lang, ["أسئلة شائعة", "Leads FAQ"])}</a>
</nav>

<!-- القسم الأول: منظور البروكر ورئيس الفريق -->
<section class="card" id="lead-create">
  <h2>➕ ${T(lang, ["الجزء 1: تسجيل العميل الجديد وضبط رقم الهاتف تلقائياً", "Part 1: New Lead Registration & Automatic Phone Formatting"])}</h2>
  <p>${T(lang, [
    "يوفر WehdatHub طرقاً مرنة وسريعة لتسجيل العملاء الجدد: عبر استمارة الموقع، أو بمشاركة جهة الاتصال من تليفونك، أو بإرسال رسالة أو فويس نوت لبوت تيليجرام ليقوم بفهم طلب العميل وتفاصيله فوراً.",
    "WehdatHub supports flexible ways to register new clients: via the web form, sharing a contact from your phone, or sending a voice note or message to the Telegram bot."
  ])}</p>

  <div class="guide-example">
    <strong>${T(lang, ["قواعد أرقام الهواتف وحماية البيانات:", "Phone Number & Data Rules:"])}</strong>
    <ul>
      <li>${T(lang, ["التعرف التلقائي على الأرقام: سواء كتبت الرقم بالأرقام العربية (٠١٠١٢٣٤٥٦٧٨) أو الإنجليزية (01012345678)، يضبطه النظام تلقائياً ليكون جاهزاً للاتصال المباشر ورسائل واتساب بنقرة واحدة.", "Automatic Digit Formatting: whether entered in Arabic or English digits, the phone number is formatted ready for instant calling and WhatsApp messaging."])}</li>
      <li>${T(lang, ["حماية سرية العملاء: حسابات إدخال البيانات في الشركة مخصصة لإدخال الوحدات فقط، وممنوعة تماماً من رؤية قائمة العملاء للحفاظ على سرية بياناتك.", "Client Data Confidentiality: data entry accounts are restricted to property inventory and cannot view client contacts, keeping your customer data secure."])}</li>
    </ul>
  </div>
  ${shot("guide/lead-intake-01-create-normalize.png", T(lang, ["شاشة تسجيل العميل الجديد والضبط التلقائي لرقم الهاتف", "New lead registration and automatic phone formatting"]))}
</section>

<section class="card" id="lead-guard">
  <h2>🛡️ ${T(lang, ["تنبيه تعارض الزملاء الذكي عند إدخال عميل مسجل مسبقاً", "Smart Colleague Duplicate Alert When Entering Existing Leads"])}</h2>
  <p>${T(lang, [
    "عندما تحاول إدخال رقم هاتف مسجل بالفعل مع زميل آخر في نفس الوكالة، ينبهك النظام فوراً لمنع التضارب وحماية خصوصية الجميع:",
    "When you enter a phone number already assigned to a colleague in your agency, the system alerts you immediately to keep work organized:"
  ])}</p>

  <ul>
    <li>${T(lang, ["تنبيه فوري أثناء الكتابة: بمجرد كتابة الرقم يظهر تنبيه أصفر واضح: «👥 الرقم ده عميل مع زميل. لو حفظت، مديرك هيتبلّغ».", "Instant Alert While Typing: as soon as you type the number, a clear yellow notice warns: '👥 This client is with a colleague. If you save, your manager is alerted.'"])}</li>
    <li>${T(lang, ["سرية تامة لبيانات الزميل والعميل: لحماية الخصوصية، لا يظهر لك اسم الزميل الآخر ولا تفاصيل العميل لمنع أي تضارب بين أعضاء الفريق.", "Full Privacy Protection: conceals colleague identity and client history to prevent conflict."])}</li>
    <li>${T(lang, ["إخطار المدير للتنسيق: يتلقى مدير الوكالة تنبيهاً فورياً بالتفاصيل الكاملة ليتخذ القرار المناسب والتنسيق بينكما.", "Instant Manager Notification: agency managers receive an alert with full context to coordinate between colleagues."])}</li>
  </ul>
  ${shot("guide/lead-intake-02-duplicate-guard.png", T(lang, ["تنبيه حماية تعارض الزملاء الذكي وإخطار الإدارة دون كشف بيانات العميل", "Smart colleague duplicate collision guard and manager notification"]))}
</section>

<section class="card" id="lead-undo">
  <h2>↩️ ${T(lang, ["إمكانية التراجع الفوري عن تعديلات العميل لمدة 10 دقائق", "10-Minute Instant Undo for Any Lead Changes"])}</h2>
  <p>${T(lang, [
    "كل إجراء يتخذه البروكر على العميل (تغيير المرحلة، تسجيل اتصال، تحديد موعد متابعة، أو كتابة ملاحظة) محمي بإمكانية التراجع الفوري لمدة 10 دقائق كاملة:",
    "Every lead action (stage transition, call logging, follow-up scheduling, notes) is protected by a 10-minute undo option:"
  ])}</p>

  <ul>
    <li>${T(lang, ["زر تراجع فوري: يظهر شريط أخضر أعلى صفحة العميل يحتوي على زر «↩️ تراجع» مع عداد تنازلي للـ 10 دقائق.", "One-Click Rollback: a prominent green banner at the top of the client page offers an '↩️ Undo' button with a 10-minute timer."])}</li>
    <li>${T(lang, ["ما يشمله التراجع: يشمل التراجع تغيير مرحلة العميل، وتعديل موعد المتابعة، وتسجيل المكالمة، والملاحظات الأخيرة.", "Covered Actions: stage shifts, follow-ups, call logs, and notes."])}</li>
  </ul>
  ${shot("guide/lead-intake-03-undo-stack.png", T(lang, ["شريط التراجع الفوري عن تعديلات العميل المتاح لمدة 10 دقائق", "10-minute reversible mutation undo banner"]))}
</section>

<section class="card" id="lead-pod">
  <h2>👥 ${T(lang, ["متابعة فريق العمل وصلاحيات رئيس الفريق", "Team Follow-Up & Team Lead Tools"])}</h2>
  <p>${T(lang, [
    "في الشركات التي تضم فرق عمل متعددة، يدعم WehdatHub تعيين رؤساء فرق لتسهيل المتابعة اليومية ومساندة البروكرز:",
    "In agencies with multiple sales teams, WehdatHub supports Team Leads to manage daily follow-up and assist brokers:"
  ])}</p>

  <ul>
    <li>${T(lang, ["متابعة عملاء الفريق: يرى رئيس الفريق كل عملاء البروكرز التابعين لفريقه، ويتلقى تنبيهات بالمتابعات المتأخرة لمساعدتهم على سرعة الإنجاز.", "Team Oversight: team leads oversee leads assigned to their team members and receive reminders for overdue follow-ups."])}</li>
    <li>${T(lang, ["إعادة توزيع العملاء داخل الفريق: يحق لرئيس الفريق إعادة توزيع الليدات بين أعضاء فريقه أو تحويل العميل لنفسه مباشرة لمساندة العميل دون الحاجة لانتظار مدير الوكالة.", "Reassigning Within Team: team leads can reassign leads among team members or take them over directly without waiting for senior managers."])}</li>
  </ul>
  ${shot("guide/lead-intake-04-team-lead-pod.png", T(lang, ["شاشة إدارة فريق العمل المصغر وصلاحيات رئيس الفريق لإعادة التوزيع", "Sub-team pod management and team lead reassignment controls"]))}
</section>

<!-- القسم الثاني: منظور مدير ومالك الوكالة -->
<section class="card" id="lead-pipeline">
  <h2>📊 ${T(lang, ["الجزء 2: لوحة مسار المبيعات الشاملة ومتابعة الصفقات والكانبان", "Part 2: Sales Pipeline Overview, Deal Stages & Kanban Board"])}</h2>
  <p>${T(lang, [
    "يمتلك مديرو الوكالة رؤية شاملة لكافة عملاء وصفقات الشركة من خلال لوحة تحكم تفاعلية وقائمة صفقات منظمة:",
    "Agency managers maintain complete oversight through the pipeline dashboard and interactive Kanban board:"
  ])}</p>

  <ul>
    <li>${T(lang, ["مراحل مسار المبيعات المعتمدة: (جديد ➡ تم التواصل ➡ مهتم ➡ معاينة ➡ تفاوض ➡ تم البيع بنجاح / صفقة ضائعة).", "Standard Pipeline Stages: (New ➡ Contacted ➡ Interested ➡ Viewing ➡ Negotiation ➡ Won / Lost)."])}</li>
    <li>${T(lang, ["تحديد سبب ضياع الصفقة: عند تحويل العميل إلى «صفقة ضائعة»، يطلب النظام تحديد سبب الخسارة (مثل: السعر، الموقع، المنافسين) لتحليل أسباب الفقد وتحسين أداء الفريق.", "Specifying Lost Reason: marking a deal as Lost prompts for the reason (price, location, competitor) to help the agency improve performance."])}</li>
    <li>${T(lang, ["دمج العملاء المكررين: إذا سُجل نفس العميل مرتين، يمكنك دمجهما في ملف واحد لنقل جميع المكالمات والمتابعات والعروض وحذف السجل المكرر.", "Merging Duplicate Leads: consolidates duplicate records into one profile, migrating all notes, calls, and sent listings."])}</li>
    <li>${T(lang, ["عملاء مالك الشركة الخاصين: يمتلك مالك الوكالة وحده حق تعليم أي عميل أو وحدة كـ «خاصة»، لتختفي تماماً عن باقي الفريق وتبقى للمالك وحده.", "Private VIP Clients: agency owners can mark specific leads or units as private, keeping them visible strictly to the owner."])}</li>
  </ul>
  ${shot("guide/lead-manager-01-pipeline-board.png", T(lang, ["لوحة مسار المبيعات الشاملة للوكالة وتتبع مراحل الصفقات والكانبان", "Agency sales pipeline funnel and interactive Kanban board"]))}
</section>

<section class="card" id="lead-rules">
  <h2>⏰ ${T(lang, ["مواعيد العمل وحساب مهل الرد بتوقيت القاهرة والتحويل التلقائي", "Working Hours, Cairo Response Timers & Auto-Reassignment"])}</h2>
  <p>${T(lang, [
    "لضمان سرعة الاستجابة للعملاء الجدد وعدم إهمال أي ليد، يتيح النظام ضبط مواعيد العمل وقواعد التحويل التلقائي:",
    "To maximize speed-to-lead and prevent forgotten inquiries, the system provides working hours and smart reassignment rules:"
  ])}</p>

  <div class="guide-example">
    <strong>${T(lang, ["آلية مواعيد الاستجابة والتحويل التلقائي:", "Working Hour Timers & Auto-Reassignment:"])}</strong>
    <ul>
      <li>${T(lang, ["حساب المواعيد بتوقيت القاهرة: تُحسب ساعات العمل ومواعيد الاستجابة وفقاً للتوقيت المحلي للشركة في القاهرة.", "Cairo Timezone Calculations: response deadlines accrue strictly during agency active hours in Cairo time."])}</li>
      <li>${T(lang, ["إيقاف العداد خارج مواعيد العمل: إذا ورد عميل جديد في وقت متأخر من الليل ومواعيد العمل تبدأ 9:00 ص، يتوقف العداد ولا تبدأ مهلة الرد إلا في تمام التاسعة صباحاً.", "After-Hours Pause: a lead arriving late at night pauses until 9:00 AM opening before the response countdown begins."])}</li>
      <li>${T(lang, ["التحويل التلقائي لو لم يتم التواصل: إذا لم يتواصل البروكر مع العميل خلال المهلة المحددة، يحول النظام العميل تلقائياً إلى زميل آخر متاح أو لرئيس الفريق لضمان عدم ضياع الفرصة.", "Auto-Reassignment if Uncontacted: if an agent does not contact a lead within the deadline, the system automatically routes the lead to an available teammate or team lead."])}</li>
    </ul>
  </div>
  ${shot("guide/lead-manager-02-rules-schedule.png", T(lang, ["قواعد توزيع العملاء المتقدمة ومواعيد العمل وحساب مهل الاستجابة بتوقيت القاهرة", "Advanced lead routing, Cairo working hours, and response deadlines"]))}
</section>

<section class="card" id="lead-away">
  <h2>🌴 ${T(lang, ["تسجيل إجازات البروكرز وتخطي التوزيع أثناء الغياب", "Broker Availability & Vacation Mode Management"])}</h2>
  <p>${T(lang, [
    "عند قيام بروكر بأخذ إجازة، تتيح لوحة الإدارة تسجيل حالته كـ «في إجازة» لضمان عدم ضياع العملاء الجدد:",
    "When an agent takes leave, managers set their status to 'On leave' to keep customer service uninterrupted:"
  ])}</p>

  <ul>
    <li>${T(lang, ["التخطي التلقائي من دور التوزيع: يتم استبعاد البروكر في إجازته تلقائياً من استقبال العملاء الجدد حتى يعود لمباشرة عمله.", "Skipping During Leave: away brokers are automatically skipped in new lead rotation until they return."])}</li>
    <li>${T(lang, ["تحويل تنبيهات المتابعة للمديرين مؤقتاً: تنبيهات المتابعات الدورية لعملاء البروكر أثناء إجازته يتم توجيهها لمدير الوكالة للمتابعة المؤقتة.", "Alert Redirection: follow-up reminders on active leads route to managers for temporary handling."])}</li>
    <li>${T(lang, ["العودة الفورية للعمل: يمكن للمدير أو البروكر إنهاء حالة الإجازة بنقرة واحدة ليعود فوراً إلى دور التوزيع واستقبال العملاء.", "Instant Return: status can be restored to Active anytime to re-enter lead rotation immediately."])}</li>
  </ul>
  ${shot("guide/lead-manager-03-broker-away.png", T(lang, ["جدول توفر البروكرز وتسجيل الإجازات واستبعاد البروكر غير المتاح من التوزيع", "Broker availability, Away status, and round-robin bypass"]))}
</section>

<section class="card" id="lead-privacy">
  <h2>🔒 ${T(lang, ["إدارة خصوصية العملاء وتصدير أو مسح البيانات عند الطلب", "Client Privacy, Data Export & Erasing Upon Request"])}</h2>
  <p>${T(lang, [
    "يلتزم WehdatHub بأعلى معايير حماية البيانات الشخصية، ويوفر لإدارة الوكالة أدوات واضحة وسهلة لحماية بيانات العملاء:",
    "WehdatHub adheres to personal data protection standards, providing managers with clear tools to govern customer privacy:"
  ])}</p>

  <h3>${T(lang, ["1. تصدير بيانات العميل الكاملة", "1. Exporting Complete Client Records"])}</h3>
  <p>${T(lang, [
    "لو طلب العميل نسخة من بياناته، يحق لمدير الوكالة بنقرة واحدة تصدير ملف منظم بجميع تعاملات العميل وروابط الوحدات التي أرسلت له.",
    "If a client requests a copy of their data, managers can export an organized archive of all their requests and shared property links."
  ])}</p>

  <h3>${T(lang, ["2. مسح بيانات العميل نهائياً عند الطلب", "2. Permanent Client Data Erasure Upon Request"])}</h3>
  <p>${T(lang, [
    "عند رغبة العميل في حذف بياناته، يفتح المدير صفحة العميل ويختار «مسح نهائي» مع إدخال آخر 4 أرقام من موبايل العميل لتأكيد العملية. يتم حذف السجل بالكامل، ويتذكر النظام هذا الرقم المحذوف لتنبيه أي بروكر لو حاول إدخاله مستقبلاً بالخطأ.",
    "When a client requests erasure, the manager chooses 'Erase for good' and confirms by entering the last 4 digits of the client's phone. The record is permanently deleted, and the system remembers the deletion to alert your team if anyone tries to re-enter it later."
  ])}</p>

  <h3>${T(lang, ["3. تنظيف السجلات القديمة غير النشطة", "3. Cleaning Up Inactive Records"])}</h3>
  <p>${T(lang, [
    "ينبه النظام مدير الوكالة بالعملاء الذين لم يُسجل عليهم أي اتصال أو تفاعل منذ 18 شهراً كاملاً، لإتاحة تنظيف السجلات القديمة وإبقاء قاعدة البيانات منظمة وحديثة.",
    "The system alerts managers about dormant leads with zero activity for 18 months, allowing them to clean up old records and keep the database relevant."
  ])}</p>
  ${shot("guide/lead-manager-04-pdpl-governance.png", T(lang, ["إدارة الخصوصية وحماية بيانات العملاء والمسح النهائي الآمن", "Privacy governance, client data protection, and permanent erasure"]))}
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
