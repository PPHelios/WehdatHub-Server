// lib/errorText.js — One table from an error code to a sentence in Arabic and English. The website pages, the app's API and
// the app read the same words, so a code never reaches a person raw (QA 2026-11-17: "follow_up_past" was shown as is).
// The API adds `message` next to `error` (api/index.js); pages use `of()` as the fallback when a route has no wording of its own.
"use strict";

const T = {
  // sign-in and access
  unauthorized: ["سجّل دخول الأول.", "Sign in first."],
  forbidden: ["مش مسموح.", "Not allowed."],
  style: ["الاختيار مش مظبوط.", "That choice isn't valid."],
  plan_feature: ["الميزة دي مش في باقتك الحالية. رقّي الباقة من صفحة الباقة.", "This is not in your current plan. Upgrade your plan on the Plan page."],
  invalid_code: ["الكود غلط أو انتهى.", "The code is wrong or has expired."],
  too_many: ["محاولات كتير. استنى شوية.", "Too many tries. Wait a moment."],
  rate_limited: ["طلبات كتير. استنى شوية وجرب تاني.", "Too many requests. Wait a moment and try again."],
  read_only_view: ["للقراءة بس وانت بتتفرج على شركة تانية.", "Read only while viewing another agency."],
  writes_off: ["التعديل مقفول دلوقتي.", "Changes are switched off right now."],
  not_found: ["مش موجود.", "Not found."],
  conflict: ["اتعدل من مكان تاني. افتحه تاني وعدّل.", "It was changed elsewhere. Open it again and redo the change."],
  version_required: ["افتح الصفحة تاني وجرب.", "Reopen the page and try again."],
  // leads
  phone_required: ["الموبايل مطلوب.", "A phone number is required."],
  phone_invalid: ["رقم الموبايل مش مظبوط.", "The phone number is not valid."],
  not_enquiry: ["الرسالة دي مش استفسار من بوابة (Bayut أو Dubizzle أو Nawy).", "That is not a portal enquiry message (Bayut, Dubizzle or Nawy)."],
  too_many_phones: ["3 أرقام بالكتير.", "At most 3 numbers."],
  lawful_basis: ["الأساس القانوني مش معروف.", "The lawful basis is not valid."],
  kind: ["النوع مش معروف.", "The type is not valid."],
  assignee: ["البروكر مش موجود.", "Unknown broker."],
  assignee_away: ["البروكر ده في إجازة ومش بياخد عملاء جداد.", "This broker is away and takes no new leads."],
  name_too_long: ["الاسم طويل: 60 حرف بالكتير.", "The name is too long: 60 characters at most."],
  notes_too_long: ["الملاحظات طويلة: 1000 حرف بالكتير.", "The notes are too long: 1,000 characters at most."],
  note_empty: ["الملاحظة فاضية.", "The note is empty."],
  note_too_long: ["الملاحظة طويلة قوي؛ اختصرها.", "The note is too long; shorten it."],
  unknown_stage: ["المرحلة مش مظبوطة.", "That stage is not valid."],
  lost_reason_required: ["اكتب سبب الضياع.", "Type why it was lost."],
  follow_up_time: ["اختار تاريخ ووقت.", "Choose a date and time."],
  follow_up_past: ["الميعاد ده عدّى؛ اختار ميعاد جاي.", "That time has passed; choose a future one."],
  unit_not_found: ["كود الوحدة مش موجود.", "Unit code not found."],
  colleague: ["العميل ده متسجل مع زميل.", "This client is registered with a colleague."],
  erased_before: ["العميل ده طلب قبل كده إن بياناته تتمسح.", "This client asked earlier to be erased."],
  // units
  incomplete: ["في بيانات ناقصة. كملها واضغط حفظ.", "Some required details are missing."],
  owner_required: ["تليفون المالك مطلوب.", "The owner's phone is required."],
  owner_name_required: ["اكتب اسم المالك، أو استخدم التليفون كاسم.", "Enter the owner's name, or use the phone as the name."],
  compound_unknown: ["الكمبوند مش في القائمة. اختاره من القائمة أو علّم إنه جديد.", "This compound is not on the list. Pick it, or mark it as new."],
  duplicate: ["شكلها نفس وحدة عندك.", "This looks like a unit you already have."],
  code_used: ["الكود ده مستخدم لوحدة تانية.", "This code is used by another unit."],
  code_invalid: ["الكود لازم يكون حرفين أو أكتر (حروف أو أرقام).", "The code needs at least 2 letters or digits."],
  photo_missing: ["في صور مرفعتش. ارفعها تاني.", "Some photos did not upload. Upload them again."],
  photos_used: ["الصور دي اتستخدمت قبل كده. اخترها تاني.", "These photos were already used. Pick them again."],
  plan_readonly: ["الحساب للقراءة بس لحد ما الباقة تتجدّد.", "The account is read-only until the plan is renewed."],
  plan_blocked: ["الحساب متوقف لحد ما الباقة تتجدّد.", "The account is stopped until the plan is renewed."],
  lapsed: ["ده محتاج باقة شغالة. جدّد الباقة الأول.", "This needs an active plan. Renew the plan first."],
  plan_limit: ["وصلت للحد الأقصى للوحدات في باقتك.", "You reached your plan's unit limit."],
  not_saved: ["الوحدة ماتحفظتش. جرب تاني.", "The unit was not saved. Try again."],
  unknown_status: ["الحالة مش معروفة.", "That status is not valid."],
  already_deleted: ["الوحدة اتمسحت قبل كده.", "This unit was already deleted."],
  // deals
  commission_missing: ["اكتب العمولة: نسبة (2%) أو مبلغ.", "Enter the commission: a % (2%) or an amount."],
  commission_pct: ["نسبة العمولة لازم تبقى بين 0 و 100.", "The commission % must be between 0 and 100."],
  commission_amount: ["مبلغ العمولة غلط.", "The commission amount is wrong."],
  commission_over_price: ["العمولة أكبر من السعر.", "The commission is more than the price."],
  price: ["اكتب السعر (رقم أكبر من صفر).", "Enter the price (a number above zero)."],
  lead_not_found: ["العميل مش موجود أو مش بتاعك.", "Lead not found or not yours."],
  split_pct: ["نسبة الزميل لازم تبقى بين 0 و 100.", "The colleague's % must be between 0 and 100."],
  status: ["الحالة مش معروفة.", "That status is not valid."],
  status_backwards: ["الصفقة مينفعش ترجع لورا. المدير بس يقدر يفتحها من جديد.", "A deal cannot go back. Only a manager can reopen it."],
  confirm_reopen: ["ده هيرجّع الصفقة لورا. أكّد وحاول تاني.", "This moves the deal back. Confirm and try again."],
  // team
  name: ["اكتب الاسم.", "Enter the name."],
  phone: ["رقم موبايل مصري صحيح (01xxxxxxxxx).", "A valid Egyptian mobile (01xxxxxxxxx)."],
  already_member: ["الرقم ده موجود بالفعل في الفريق.", "This number is already on your team."],
  seats: ["مقاعد الباقة كلها مستخدمة.", "Every seat on your plan is taken."],
  // ai
  ai_blocked: ["الذكاء الاصطناعي مش متاح دلوقتي. املأ الحقول بإيدك.", "AI is not available now. Fill the fields by hand."],
  ai_unavailable: ["الذكاء الاصطناعي مش بيرد دلوقتي. املأ بإيدك أو جرب بعد شوية.", "The AI is not answering right now. Fill it by hand or try again shortly."],
  not_heard: ["مسمعناش كلام واضح. جرب تاني أو اكتب.", "We couldn't hear clear words. Try again or type it."],
  no_audio: ["مفيش تسجيل صوت. سجّل تاني.", "No voice recording came through. Record again."],
  nothing_to_read: ["اكتب وصف أو سجّل فويس الأول.", "Type a description or record a voice note first."],
  // general (QA round 3, step 1: every code the app's API can answer has words)
  bad_request: ["الطلب مش مفهوم. افتح الصفحة تاني وجرب.", "The request was not understood. Reopen the page and try again."],
  audit: ["مقدرناش نسجل التغيير في السجل، فمتعملش. جرب تاني.", "The change could not be logged, so it was not made. Try again."],
  storage_unavailable: ["تخزين الصور مش متاح دلوقتي. جرب بعد شوية.", "Photo storage is not available right now. Try again shortly."],
  daily_cap: ["وصلت للحد اليومي. يرجع بكرة.", "You reached today's limit. It resets tomorrow."],
  too_deep: ["النتايج دي بعيدة أوي. ضيّق البحث أو استخدم الفلاتر.", "That is too far down the list. Narrow the search or use the filters."],
  too_many_requests: ["طلبات كتير. استنى شوية وجرب تاني.", "Too many requests. Wait a moment and try again."],
  empty: ["اكتب حاجة الأول.", "Type something first."],
  text: ["اكتب كلام أطول شوية.", "Write a little more."],
  lang: ["اختار اللغة.", "Choose the language."],
  bad_chat_fp: ["الشات ده مش متعرّف. افتح ملف الشات تاني وجرب.", "This chat was not recognised. Open the chat file again and try."],
  bad_dates: ["التواريخ مش مظبوطة.", "The dates are not valid."],
  bad_pin: ["اللوكيشن مش مفهوم. حط لينك جوجل ماب أو إحداثيات.", "The location is not clear. Paste a Google Maps link or coordinates."],
  deleted: ["الوحدة دي ممسوحة. رجّعها الأول.", "This unit is deleted. Restore it first."],
  hidden: ["التفاصيل دي خاصة. اطلب الإذن من المدير.", "These details are private. Ask a manager for access."],
  unknown_role: ["الدور ده مش معروف.", "That role is not known."],
  too_many_photos: ["صور كتير. الحد 15 صورة للوحدة.", "Too many photos. A unit takes up to 15."],
  upload_failed: ["الصورة مترفعتش. جرب تاني.", "The photo did not upload. Try again."],
  already_flagged: ["الطلب ده متبعت للمدير بالفعل.", "This was already sent to a manager."],
  busy: ["فيه عملية شغالة دلوقتي. استنى شوية.", "Something is already running. Wait a moment."],
  expired: ["انتهت صلاحيته. ابدأ من جديد.", "It has expired. Start again."],
  invalid: ["القيمة دي مش مظبوطة.", "That value is not valid."],
  missing: ["فيه بيانات ناقصة.", "Something required is missing."],
  too_long: ["الكلام طويل أوي. اختصره.", "That is too long. Shorten it."],
  // team (services/team.js)
  same: ["ده نفس اللي موجود بالفعل.", "That is already the case."],
  self: ["مينفعش تعمل ده لنفسك.", "You cannot do this to yourself."],
  rank: ["مينفعش تغيّر دور مالك الشركة.", "The agency owner's role cannot be changed."],
  role: ["الدور مش مظبوط. اختار من القايمة: بروكر أو مدير أو مدخل بيانات.", "That role isn't valid. Pick one from the list: broker, manager or data entry."],
  phone_taken: ["الرقم ده مسجل لشخص تاني.", "This number belongs to someone else."],
  has_records: ["عنده صفقات أو وحدات، فمينفعش يتمسح. أوقفه بس.", "They have deals or units, so they cannot be deleted. Deactivate them instead."],
  active: ["أوقفه الأول.", "Deactivate them first."],
  team_lead_nested: ["قائد الفريق مينفعش يبقى تحت قائد فريق تاني.", "A team lead cannot be in another team lead's team."],
  team_lead_not_found: ["قائد الفريق ده مش موجود.", "That team lead was not found."],
  // units
  unit_limit: ["وصلت لحد الوحدات في باقتك.", "You reached your plan's unit limit."],
  unit_changed: ["الوحدة اتعدلت من مكان تاني. افتحها تاني.", "The unit was changed elsewhere. Open it again."],
  no_lease: ["مفيش عقد إيجار على الوحدة دي.", "There is no lease on this unit."],
  not_rent: ["الوحدة دي مش للإيجار.", "This unit is not for rent."],
  outside_egypt: ["المكان ده برة مصر.", "That place is outside Egypt."],
  no_place: ["اختار المكان من القايمة.", "Pick the place from the list."],
  needs_area: ["المساحة مطلوبة.", "The area is required."],
  // leads and deals
  past: ["الميعاد ده فات. اختار ميعاد جاي.", "That time has passed. Pick a time ahead."],
  follow_up_kind: ["اختار نوع المتابعة: مكالمة أو معاينة.", "Choose the follow-up kind: a call or a viewing."],
  no_open_follow_up: ["مفيش متابعة مفتوحة.", "There is no open follow-up."],
  notes_full: ["الملاحظات وصلت للحد. امسح القديم.", "Notes are full. Remove older ones."],
  already_assigned: ["العميل متحول له بالفعل.", "The lead is already assigned to them."],
  not_own: ["ده مش بتاعك.", "This is not yours."],
  stage: ["اختار مرحلة من القايمة.", "Pick a stage from the list."]
};

/** The sentence for an error code, or null when the code has no wording here. */
function of(code, lang = "ar") {
  const pair = T[String(code || "")];
  return pair ? pair[lang === "en" ? 1 : 0] : null;
}

/** The sentence, or a short generic line that never shows the raw code. */
function ofOrGeneric(code, lang = "ar") {
  return of(code, lang) || (lang === "en" ? "Something went wrong. Try again." : "حصلت مشكلة. جرب تاني.");
}

module.exports = { of, ofOrGeneric, CODES: Object.keys(T) };
