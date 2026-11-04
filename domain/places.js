// domain/places.js — Bilingual places: areas, developers and compounds as language-neutral keys (pure)
// Seeds the compound_synonyms table (db/migrations/004) and resolves query text on the search side,
// so "Mountain View" and "ماونتن فيو" become the same key.
"use strict";

const { normalizeSearch } = require("./searchText");

const AREAS = {
  new_cairo: ["التجمع الخامس", "التجمع", "القاهرة الجديدة", "new cairo", "5th settlement", "fifth settlement", "tagamoa"],
  sheikh_zayed: ["الشيخ زايد", "زايد", "sheikh zayed", "zayed"],
  october: ["6 أكتوبر", "أكتوبر", "6th of october", "6 october", "october"],
  north_coast: ["الساحل الشمالي", "الساحل", "north coast", "sahel"],
  new_capital: ["العاصمة الإدارية", "العاصمة", "new capital", "new administrative capital"],
  shorouk: ["الشروق", "el shorouk", "shorouk"],
  mostakbal: ["مدينة المستقبل", "المستقبل", "mostakbal city", "future city"],
  ain_sokhna: ["العين السخنة", "السخنة", "ain sokhna", "sokhna"]
};

const DEVELOPERS = {
  sodic: ["سوديك", "sodic"],
  emaar: ["إعمار", "اعمار", "emaar"],
  palm_hills: ["بالم هيلز", "palm hills"],
  mountain_view: ["ماونتن فيو", "mountain view"],
  ora: ["أورا", "ora developers"],
  tmg: ["طلعت مصطفى", "talaat moustafa", "tmg"],
  hassan_allam: ["حسن علام", "hassan allam"]
};

// key: [area, developer, synonyms...] — the first Latin synonym is the canonical English name.
const COMPOUNDS = {
  hyde_park: ["new_cairo", null, "هايد بارك", "هايدبارك", "hyde park", "hydepark"],
  mivida: ["new_cairo", "emaar", "ميفيدا", "mivida"],
  madinaty: [null, "tmg", "مدينتي", "madinaty"],
  rehab: ["new_cairo", "tmg", "الرحاب", "رحاب", "al rehab", "rehab"],
  mv_icity: ["new_cairo", "mountain_view", "ماونتن فيو آي سيتي", "آي سيتي", "اي سيتي", "mountain view icity", "icity", "i city"],
  villette: ["new_cairo", "sodic", "فيليت", "villette"],
  eastown: ["new_cairo", "sodic", "ايست تاون", "eastown", "east town"],
  sodic_east: ["shorouk", "sodic", "سوديك ايست", "sodic east"],
  westown: ["sheikh_zayed", "sodic", "ويست تاون", "westown", "west town"],
  noll: ["new_cairo", null, "نول", "noll", "كليك", "kleek"],
  palm_hills_october: ["october", "palm_hills", "بالم هيلز أكتوبر", "palm hills october"],
  badya: ["october", "palm_hills", "بادية", "badya"],
  zed_west: ["sheikh_zayed", "ora", "زد الشيخ زايد", "زد", "zed sheikh zayed", "zed west", "zed"],
  zed_east: ["new_cairo", "ora", "زد ايست", "zed east"],
  marassi: ["north_coast", "emaar", "مراسي", "marassi"],
  swan_lake: ["new_cairo", "hassan_allam", "سوان ليك", "سوانليك", "swan lake", "swanlake"],
  beverly_hills: ["sheikh_zayed", null, "بيفرلي هيلز", "beverly hills"],
  // New Cairo compounds from the NCH rent sheet (names as Haytham confirmed them).
  lake_view: ["new_cairo", null, "lake view", "ليك فيو", "لايك فيو"],
  fifth_square: ["new_cairo", null, "5th square", "فيفث سكوير"],
  cfc: ["new_cairo", null, "cfc", "cairo festival city", "سي اف سي", "كايرو فيستيفال سيتي"],
  the_village: ["new_cairo", null, "the village", "ذا فيليدج", "افيليدج"],
  the_square: ["new_cairo", null, "the square", "ذا سكوير", "اسكوير"],
  village_gate: ["new_cairo", null, "village gate", "فيليدج جيت", "فيلدج جيت"],
  galleria_moon_valley: ["new_cairo", null, "galleria moon valley", "جاليريا مون فالي", "مون فالي"],
  mvhp: ["new_cairo", "mountain_view", "mvhp", "mountain view hyde park", "ماونتن فيو هايد بارك"],
  azad: ["new_cairo", null, "azad", "أزاد"],
  el_patio: ["new_cairo", null, "el patio", "الباتيو"],
  dyar_park: ["new_cairo", null, "dyar park", "ديار بارك", "ديار", "ديار المخابرات"],
  uptown_cairo: ["new_cairo", null, "uptown cairo", "أبتاون كايرو", "ابتاون"],
  pk2: ["new_cairo", null, "pk2"],
  vgk: ["new_cairo", null, "vgk"],
  village_avenue: ["new_cairo", null, "village avenue", "فيليدج أفينيو"],
  palm_hills_new_cairo: ["new_cairo", "palm_hills", "palm hills new cairo", "بالم هيلز القاهرة الجديدة", "بالم هيلز نيو كايرو"],
  porto_new_cairo: ["new_cairo", null, "porto new cairo", "porto", "بورتو نيو كايرو"]
};

// New Cairo, Sheikh Zayed, New Capital, North Coast and Ain Sokhna compounds from the NCH sheet list.
const EXTRA_COMPOUNDS = {
  "lake_view": ["new_cairo", null, "lakeview"],
  "lake_view_residence": ["new_cairo", null, "lake view residence", "lvr", "ليك فيو ريزيدنس", "لايك فيو ريزيدنس"],
  "fifth_square": ["new_cairo", null, "fifth square", "فيفت سكوير", "5th سكوير"],
  "cfc": ["new_cairo", null, "cairo festival", "كايرو فستيفال"],
  "the_village": ["new_cairo", null, "الفيليدج", "فيلدج"],
  "the_square": ["new_cairo", null, "السكوير"],
  "village_gate": ["new_cairo", null, "بوابة القرية"],
  "vgk": ["new_cairo", null, "village gardens katameya", "فيلدج جاردنز قطامية", "فيليدج جاردنز القطامية", "في جي كي"],
  "village_avenue": ["new_cairo", null, "فيلدج افينيو"],
  "palm_hills_katameya": ["new_cairo", null, "pk1", "palm hills katameya", "palm hills kattameya", "بالم هيلز القطامية", "بي كي 1"],
  "palm_hills_katameya_2": ["new_cairo", null, "palm hills katameya 2", "بالم هيلز القطامية 2", "بي كي 2"],
  "palm_hills_new_cairo": ["new_cairo", null, "phnc"],
  "mountain_view_hyde_park": ["new_cairo", null, "ماونتن فيو هيد بارك"],
  "mountain_view_1": ["new_cairo", null, "mv1", "mountain view one", "ماونتن فيو وان"],
  "mountain_view_2": ["new_cairo", null, "mv2", "mountain view two"],
  "mountain_view_executive_residence": ["new_cairo", null, "mver", "mountain view executive", "mountain view katameya", "ماونتن فيو اكزيكتيف", "ماونتن فيو قطامية"],
  "mountain_view_icity_new_cairo": ["new_cairo", null, "icity new cairo", "icity tagamoa", "اي سيتي التجمع", "ايسيتي"],
  "hyde_park": ["new_cairo", null, "هيد بارك"],
  "mivida": ["new_cairo", null, "mevida", "مڤيدا", "مافيدا"],
  "villette_sodic": ["new_cairo", null, "villette sodic", "فيليت سوديك", "فليت"],
  "eastown": ["new_cairo", null, "eastown sodic", "ايستاون", "إيست تاون سوديك"],
  "ednc": ["new_cairo", null, "ednc", "eastown district new cairo", "اي دي ان سي"],
  "katameya_dunes": ["new_cairo", null, "katameya dunes", "kattameya dunes", "قطامية ديونز", "القطامية ديونز", "ديونز"],
  "katameya_heights": ["new_cairo", null, "katameya heights", "kattameya heights", "قطامية هايتس", "القطامية هايتس"],
  "katameya_hills": ["new_cairo", null, "katameya hills", "kattameya hills", "قطامية هيلز", "القطامية هيلز"],
  "katameya_residence": ["new_cairo", null, "katameya residence", "قطامية ريزيدنس", "القطامية ريزيدنس"],
  "katameya_creeks": ["new_cairo", null, "katameya creeks", "قطامية كريك", "قطامية كريكس"],
  "galleria_moon_valley": ["new_cairo", null, "galleria", "moon valley", "جاليريا"],
  "moon_valley_1": ["new_cairo", null, "moon valley 1"],
  "moon_valley_2": ["new_cairo", null, "moon valley 2"],
  "azad": ["new_cairo", null, "azad new cairo"],
  "el_patio_1": ["new_cairo", null, "patio 1", "باتيو 1"],
  "el_patio_2": ["new_cairo", null, "patio 2", "باتيو 2"],
  "el_patio_3": ["new_cairo", null, "patio 3", "باتيو 3"],
  "el_patio_7": ["new_cairo", null, "patio 7", "باتيو 7"],
  "el_patio_oro": ["new_cairo", null, "el patio oro", "patio oro", "الباتيو اورو", "باتيو اورو", "اورو"],
  "porto_new_cairo": ["new_cairo", null, "porto cairo", "بورتو كايرو", "بورتو التجمع"],
  "layan": ["new_cairo", null, "layan", "layan sabbour", "ليان", "ليان صبور"],
  "platinum": ["new_cairo", null, "platinum club", "بلاتينيوم", "بلاتنيوم"],
  "azzar": ["new_cairo", null, "azzar", "azzar new cairo", "azar", "أزار", "ازار"],
  "midtown_new_cairo": ["new_cairo", null, "midtown new cairo", "ميدتاون", "ميد تاون التجمع"],
  "belle_vie": ["new_cairo", null, "belle vie", "bellevie", "بيل في", "بيل ڤي"],
  "stone_park": ["new_cairo", null, "stone park", "stonepark", "ستون بارك", "ستونبارك", "رويا ستون بارك"],
  "stone_residence": ["new_cairo", null, "stone residence", "ستون ريزيدنس", "ستون ريزيدنس التجمع"],
  "la_mirada": ["new_cairo", null, "la mirada", "lamirada", "لا ميرادا", "لاميرادا"],
  "the_waterway": ["new_cairo", null, "the waterway", "waterway", "water way", "ذا وتر واي", "وتر واي", "ووترواي", "الوتر واي"],
  "the_waterway_the_view": ["new_cairo", null, "waterway the view", "the view waterway", "ووتر واي ذا فيو"],
  "white_residence": ["new_cairo", null, "white residence", "وايت ريزيدنس"],
  "swan_lake_new_cairo": ["new_cairo", null, "swan lake kattameya", "slk", "سوان ليك القطامية"],
  "swan_lake_residences": ["new_cairo", null, "slr", "swan lake residences", "سوان ليك ريزيدنسز", "سوان ليك التجمع"],
  "mirage_city": ["new_cairo", null, "mirage city", "mirage", "ميراج سيتي"],
  "al_rehab_city": ["new_cairo", null, "rehab city", "مدينة الرحاب"],
  "sarai": ["new_cairo", null, "sarai madinet nasr", "سراي", "سرايا"],
  "taj_city": ["new_cairo", null, "taj city", "tag city", "تاج سيتي", "تاج سيتى"],
  "shaza_taj_city": ["new_cairo", null, "shaza", "شذا تاج سيتي"],
  "bloomfields": ["new_cairo", null, "bloomfields", "bloom fields", "بلومفيلدز", "بلوم فيلدز"],
  "il_bosco_city": ["new_cairo", null, "il bosco city", "il bosco mostakbal", "البوسكو سيتي", "البوسكو ف ال مستقبل"],
  "green_square": ["new_cairo", null, "green square", "green square sabbour", "جرين سكوير", "جرين اسكوير"],
  "the_city_of_odyssia": ["new_cairo", null, "odyssia", "the city of odyssia", "أوديسيا", "اوديسيا", "مدينة اوديسيا"],
  "aria": ["new_cairo", null, "aria sabbour", "أريا", "اريا صبور"],
  "haptown": ["new_cairo", null, "haptown", "haptown hassan allam", "هاب تاون", "هابتاون"],
  "aliva_mountain_view": ["new_cairo", null, "aliva", "aliva mostakbal city", "اليفا", "أليفا ماونتن فيو"],
  "monte_napoleone": ["new_cairo", null, "monte napoleone", "مونتي نابوليوني", "مونتي نابليون"],
  "la_vista_city": ["new_cairo", null, "la vista city", "lvc", "لا فيستا سيتي", "لافيستا سيتي"],
  "beverly_hills": ["sheikh_zayed", null, "beverly hills sodic", "بفرلي هيلز"],
  "allegria": ["sheikh_zayed", null, "allegria", "allegria sodic", "اليجريا", "أليجريا", "الجريا"],
  "westown": ["sheikh_zayed", null, "westown sodic", "ويستاون", "وست تاون"],
  "the_estates": ["sheikh_zayed", null, "the estates", "estates sodic", "ذا استيتس", "ذا إستيتس", "دي استيتس"],
  "karmell_sodic": ["sheikh_zayed", null, "karmell", "karmell sodic", "كارميل", "كرميل سوديك"],
  "vye_sodic": ["sheikh_zayed", null, "vye", "vye sodic", "فاي", "ڤاي سوديك"],
  "casa": ["sheikh_zayed", null, "casa sodic", "كازا"],
  "palm_hills_october": ["sheikh_zayed", null, "pho", "بالم هيلز 6 اكتوبر"],
  "palm_valley": ["sheikh_zayed", null, "palm valley", "palm valley palm hills", "بالم فالي"],
  "palm_parks": ["sheikh_zayed", null, "palm parks", "بالم باركس", "بالم بارك"],
  "badya": ["sheikh_zayed", null, "badya palm hills", "باديا", "بادية بالم هيلز"],
  "the_crown": ["sheikh_zayed", null, "the crown", "crown palm hills", "ذا كراون", "كراون بالم هيلز"],
  "woodville": ["sheikh_zayed", null, "woodville", "woodville palm hills", "وودفيل", "وود فيل"],
  "bamboo_palm_hills": ["sheikh_zayed", null, "بامبو", "بامبو بالم هيلز"],
  "mountain_view_october_park": ["sheikh_zayed", null, "mv october park", "mvop", "mountain view october", "ماونتن فيو أكتوبر بارك", "ماونتن فيو اكتوبر"],
  "mountain_view_chillout_park": ["sheikh_zayed", null, "chillout park", "mv chillout", "تشيل اوت بارك", "شيل اوت بارك", "ماونتن فيو تشيل اوت"],
  "mountain_view_giza_plateau": ["sheikh_zayed", null, "giza plateau", "mv giza plateau", "جيزة بلاتو", "ماونتن فيو جيزة بلاتو"],
  "mountain_view_4": ["sheikh_zayed", null, "mv4"],
  "mountain_view_icity_october": ["sheikh_zayed", null, "icity october", "mv icity october", "ماونتن فيو اي سيتي اكتوبر", "ايسيتي 6 اكتوبر"],
  "zayed_dunes": ["sheikh_zayed", null, "zayed dunes", "زايد ديونز", "ديونز الشيخ زايد"],
  "zayed_regency": ["sheikh_zayed", null, "zayed regency", "زايد ريجنسي", "زايد ريجنسى"],
  "tara": ["sheikh_zayed", null, "تارا", "تارا الشيخ زايد"],
  "al_rabwa": ["sheikh_zayed", null, "rabwa", "al rabwa", "الربوة"],
  "etapa": ["sheikh_zayed", null, "etapa", "etapa city edge", "ايتابا", "إيتابا"],
  "zed_towers_sheikh_zayed": ["sheikh_zayed", null, "zed towers", "zed zayed", "ابراج زد", "ساويرس زايد"],
  "o_west": ["sheikh_zayed", null, "o west", "owest", "orascom o west", "أو ويست", "او ويست", "أوراسكوم او ويست"],
  "joulz": ["sheikh_zayed", null, "joulz", "joulz inertia", "جولز"],
  "sun_capital": ["sheikh_zayed", null, "sun capital", "sun capital 6th october", "صن كابيتال", "صن كابيتل"],
  "dreamland": ["sheikh_zayed", null, "dreamland", "dream land", "دريم لاند", "دريملاند"],
  "ashgar_city": ["sheikh_zayed", null, "ashgar city", "al ashgar", "أشجار سيتي", "حى الاشجار", "الاشجار"],
  "pyramids_heights": ["sheikh_zayed", null, "pyramids heights", "بيراميدز هايتس", "بيرامدز هايتس"],
  "swan_lake_west": ["sheikh_zayed", null, "swan lake west", "slw", "سوان ليك ويست", "سوان ليك الشيخ زايد"],
  "keeva": ["sheikh_zayed", null, "keeva", "keeva sabbour", "كيفا", "كيفا صبور"],
  "el_patio_zahraa": ["sheikh_zayed", null, "patio zahraa", "el patio zahraa", "الباتيو الزهراء", "باتيو زهراء"],
  "el_patio_6": ["sheikh_zayed", null, "patio 6", "باتيو 6"],
  "grand_heights": ["sheikh_zayed", null, "grand heights", "جراند هايتس"],
  "green_3": ["sheikh_zayed", null, "green 3", "green 4", "green 5", "green 6", "جرين 3", "جرين 4", "جرين 5", "جرين 6"],
  "tawny": ["sheikh_zayed", null, "tawny hyde park", "تاوني", "تاوني هايد بارك"],
  "ever_west": ["sheikh_zayed", null, "ever cred", "إيفر", "ايفر 6 اكتوبر"],
  "il_bosco_new_capital": ["new_capital", null, "il bosco", "il bosco capital", "il bosco misr italia", "البوسكو", "البوسكو العاصمة الادارية"],
  "vinci": ["new_capital", null, "vinci new capital", "vinci misr italia", "فينشي", "فينشي العاصمة الادارية"],
  "midtown_sky": ["new_capital", null, "midtown sky", "ميدتاون سكاي", "ميد تاون سكاى"],
  "midtown_solo": ["new_capital", null, "midtown solo", "ميدتاون سولو", "ميد تاون سولو"],
  "midtown_condo": ["new_capital", null, "midtown condo", "ميدتاون كوندو"],
  "midtown_villa": ["new_capital", null, "midtown villa", "ميدتاون فيلا"],
  "scene_7": ["new_capital", null, "scene 7", "scene seven", "سين 7", "سين سيفن"],
  "sueno": ["new_capital", null, "sueno", "sueno new capital", "سوينو", "كيمبوند سوينو"],
  "oia": ["new_capital", null, "oia new capital", "أويا", "اويا"],
  "scenario": ["new_capital", null, "scenario", "سيناريو"],
  "de_joya_1": ["new_capital", null, "de joya", "de joya 1", "دي جويا", "ديجويا 1"],
  "de_joya_2": ["new_capital", null, "de joya 2", "دي جويا 2"],
  "de_joya_3": ["new_capital", null, "de joya 3", "دي جويا 3"],
  "green_river": ["new_capital", null, "green river", "النهر الأخضر", "النهر الاخضر"],
  "capital_heights_1": ["new_capital", null, "capital heights 1", "كابيتال هايتس 1"],
  "capital_heights_2": ["new_capital", null, "capital heights 2", "كابيتال هايتس 2"],
  "the_city": ["new_capital", null, "the city", "master the city", "ذا سيتي", "ذا سيتى العاصمة"],
  "al_maqsad": ["new_capital", null, "al maqsad", "maqsad", "المقصد", "المقصد سيتي ايدج"],
  "armonia": ["new_capital", null, "armonia", "أرمونيا", "ارمونيا"],
  "castle_landmark": ["new_capital", null, "castle landmark", "كاسيل لاندمارك", "كاسل لاندمارك"],
  "rivan": ["new_capital", null, "rivan", "ريفان"],
  "boardwalk": ["new_capital", null, "boardwalk", "بورد ووك", "بوردووك"],
  "anakaji": ["new_capital", null, "anakaji", "أنا كاجي", "اناكاجي"],
  "stau": ["new_capital", null, "stau", "ستو العاصمة"],
  "uptown_cairo": [null, null, "uptown", "emaar uptown", "اب تاون", "إعمار أبتاون"],
  "mivida_gardens": [null, null, "mivida gardens", "ميفيدا جاردنز"],
  "degla_palms": [null, null, "degla palms", "دجلة بالمز", "دجله بالمز"],
  "degla_landmark": [null, null, "degla landmark", "دجلة لاندمارك"],
  "degla_view": [null, null, "degla view", "دجلة فيو"],
  "bavaria_town": [null, null, "bavaria town", "bavaria", "بافاريا تاون", "بافاريا معمار المرشدي"],
  "one_kattameya": [null, null, "one kattameya", "one katameya", "وان قطامية", "وان قطاميه", "معمار المرشدي وان قطامية"],
  "zahraa_maadi": [null, null, "zahraa maadi", "زهراء المعادي", "زهراء المعادى"],
  "promenade_maadi": [null, null, "promenade maadi", "بروميناد المعادي"],
  "skyline": [null, null, "skyline", "skyline morshedy", "سكاي لاين", "سكايلاين معمار المرشدي"],
  "marassi": ["north_coast", null, "marassi emaar", "مراسي الساحل الشمالي"],
  "hacienda_bay": ["north_coast", null, "hacienda bay", "هاسيندا باي", "هسيندا باي", "هاسيندا"],
  "hacienda_white": ["north_coast", null, "hacienda white", "هاسيندا وايت", "هسيندا وايت"],
  "hacienda_west": ["north_coast", null, "hacienda west", "هاسيندا ويست"],
  "hacienda_waters": ["north_coast", null, "hacienda waters", "هاسيندا وترز", "هاسيندا ووترز"],
  "amwaj": ["north_coast", null, "amwaj", "amwaj sabbour", "أمواج", "امواج", "امواج الساحل"],
  "telal_sahel": ["north_coast", null, "telal sahel", "telal el alamein", "تلال الساحل", "تلال العلمين"],
  "la_vista_bay": ["north_coast", null, "la vista bay", "lvb", "لا فيستا باي", "لافيستا باى"],
  "la_vista_cascada": ["north_coast", null, "la vista cascada", "lvc", "لا فيستا كاسكادا", "لافيستا كاسكادا"],
  "la_vista_ras_el_hikma": ["north_coast", null, "la vista ras el hikma", "لا فيستا راس الحكمة", "لافيستا رأس الحكمة"],
  "mountain_view_ras_el_hikma": ["north_coast", null, "mv ras el hikma", "mvrh", "mountain view sahel", "ماونتن فيو راس الحكمة", "ماونتن فيو الساحل"],
  "mountain_view_sidi_abd_el_rahman": ["north_coast", null, "mv sidi abd el rahman", "ماونتن فيو سيدي عبد الرحمن"],
  "fouka_bay": ["north_coast", null, "fouka bay", "fouka", "فوكا باي", "فوكاباي", "فوكا باى"],
  "d_bay": ["north_coast", null, "dbay", "d-bay", "tatweer d-bay", "دي باي", "دي باى"],
  "salt": ["north_coast", null, "salt tatweer misr", "سولت"],
  "silver_sands": ["north_coast", null, "silver sands", "silversands", "سيلفر ساندز", "سيلفرساندز نجيب ساويرس"],
  "almaza_bay": ["north_coast", null, "almaza bay", "almaza", "ألماظة باي", "الماظة باي", "الماظه باى"],
  "cali_coast": ["north_coast", null, "cali coast", "كالي كوست", "كالى كوست"],
  "seazen": ["north_coast", null, "seazen", "seazen al qamzi", "سيزن"],
  "sidi_heneish_village": ["north_coast", null, "sidi heneish", "سيدي حنيش"],
  "koun": ["north_coast", null, "koun", "koun mabany edris", "كون راس الحكمة"],
  "ghazala_bay": ["north_coast", null, "ghazala bay", "غزالة باي", "غزاله باى"],
  "bianchi_ilios": ["north_coast", null, "bianchi", "bianchi ilios", "بيانكي", "بيانكي الساحل"],
  "plage": ["north_coast", null, "plage mountain view", "بلاج", "بلاج ماونتن فيو"],
  "southmed": ["north_coast", null, "southmed", "south med", "طلعت مصطفى ساوث ميد", "ساوث ميد"],
  "telal_sokhna": ["ain_sokhna", null, "telal sokhna", "تلال السخنة", "تلال العين السخنة"],
  "il_monte_galala": ["ain_sokhna", null, "il monte galala", "monte galala", "المونت جلالة", "مونت جلالة", "جلالة"],
  "la_vista_1_7": ["ain_sokhna", null, "la vista 1", "la vista 2", "la vista 3", "la vista sokhna", "لافيستا السخنة", "لافيستا 1", "لافيستا 2"],
  "azha_sokhna": ["ain_sokhna", null, "azha", "azha ain sokhna", "أزها", "ازها", "ازها السخنة"],
  "carnelia": ["ain_sokhna", null, "carnelia", "carnelia sokhna", "كارنيليا", "كارنيليا السخنة"],
  "little_venice": ["ain_sokhna", null, "little venice", "ليتل فينيس", "ليتل فينس"],
  "porto_sokhna": ["ain_sokhna", null, "porto sokhna", "بورتو السخنة", "بورتو سخنة"],
  "ein_hills": ["ain_sokhna", null, "ein hills", "ein sokhna hills", "عين هيلز"],
  "baymount": ["ain_sokhna", null, "baymount", "baymount sokhna", "باي ماونت", "بايماونت"],
  "majada": ["ain_sokhna", null, "majada", "majada sokhna", "ماجادا", "ماچادا"],
  "kai_sokhna": ["ain_sokhna", null, "kai sokhna", "كاي السخنة", "كاي سخنه"],
  "el_gouna": ["ain_sokhna", null, "gouna", "el gouna", "الجونة", "الجونه"],
};
for (const [key, v] of Object.entries(EXTRA_COMPOUNDS)) {
  COMPOUNDS[key] = COMPOUNDS[key] ? [...COMPOUNDS[key], ...v.slice(2)] : v;
}

/** Every synonym row: { kind, key, synonym, norm, area_key, developer_key }. */
function synonymRows() {
  const rows = [];
  const push = (kind, key, syn, area = null, dev = null) =>
    rows.push({ kind, key, synonym: syn, norm: normalizeSearch(syn), area_key: area, developer_key: dev });
  for (const [key, syns] of Object.entries(AREAS)) syns.forEach((s) => push("area", key, s));
  for (const [key, syns] of Object.entries(DEVELOPERS)) syns.forEach((s) => push("developer", key, s));
  for (const [key, [area, dev, ...syns]] of Object.entries(COMPOUNDS)) syns.forEach((s) => push("compound", key, s, area, dev));
  return rows;
}

// Longest normalized synonym first, compounds before developers before areas on equal length.
const KIND_RANK = { compound: 0, developer: 1, area: 2 };
const MATCHERS = synonymRows()
  .filter((r) => r.norm)
  .sort((a, b) => b.norm.length - a.norm.length || KIND_RANK[a.kind] - KIND_RANK[b.kind]);

/**
 * Finds every place named in the text (whole-word matches). Matched words are consumed so
 * "palm hills october" is one compound, not the developer plus an area.
 * @returns {{ places: Array<{kind, key}>, rest: string }}
 */
function findPlaces(text) {
  let hay = ` ${normalizeSearch(text)} `;
  const places = [];
  for (const m of MATCHERS) {
    for (const needle of [` ${m.norm} `, ` و${m.norm} `, ` ب${m.norm} `]) {
      if (hay.includes(needle)) {
        if (!places.some((p) => p.kind === m.kind && p.key === m.key)) places.push({ kind: m.kind, key: m.key });
        hay = hay.split(needle).join(" ");
      }
    }
  }
  return { places, rest: hay.replace(/\s+/g, " ").trim() };
}

/** The single place a short phrase names (e.g. an AI "compound" field), or null. */
function resolvePlace(text) {
  const norm = normalizeSearch(text);
  if (!norm) return null;
  const exact = MATCHERS.find((m) => m.norm === norm);
  if (exact) return { kind: exact.kind, key: exact.key };
  const { places, rest } = findPlaces(text);
  return places.length === 1 && rest.length <= 2 ? places[0] : null;
}

/** Display name of a place key ({ ar, en }). */
function placeName(kind, key) {
  const syns = kind === "area" ? AREAS[key] : kind === "developer" ? DEVELOPERS[key] : COMPOUNDS[key]?.slice(2);
  if (!syns) return null;
  return { ar: syns.find((s) => /[؀-ۿ]/.test(s)) || syns[0], en: syns.find((s) => !/[؀-ۿ]/.test(s)) || syns[0] };
}

/** Edit distance (Levenshtein), stopping early past max. */
function distance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Spelling-blind form for the fuzzy match: no spaces, a letter said twice once ("هاييد" = "هايد").
const fuzzKey = (s) => normalizeSearch(s).replace(/\s+/g, "").replace(/(.)\1+/g, "$1");

/**
 * F6: a compound name as the AI heard it ("هاييد بارك") snapped to a known one ("هايد بارك"): the agency's own names
 * first (its units and catalogue projects), then the common compounds. Only a close, unambiguous match snaps
 * (1 letter off, 2 for long names); an exact known name or anything else comes back unchanged.
 * @returns {{ name: string, changed: boolean }}
 */
function snapCompound(name, agencyNames = []) {
  const raw = String(name || "").trim();
  if (!raw) return { name: raw, changed: false };
  const arabic = /[؀-ۿ]/.test(raw);
  const key = fuzzKey(raw);
  const candidates = [];
  for (const n of agencyNames) if (n && /[؀-ۿ]/.test(n) === arabic) candidates.push(String(n).trim());
  for (const [, , ...syns] of Object.values(COMPOUNDS)) {
    const pick = syns.find((s) => /[؀-ۿ]/.test(s) === arabic);
    for (const s of syns) if (/[؀-ۿ]/.test(s) === arabic) candidates.push({ syn: s, display: arabic ? pick : syns.find((x) => !/[؀-ۿ]/.test(x)) });
  }
  const norm = normalizeSearch(raw);
  for (const c of candidates) if (normalizeSearch(typeof c === "string" ? c : c.syn) === norm) return { name: raw, changed: false };
  const max = key.length >= 8 ? 2 : 1;
  let best = null;
  let tie = false;
  for (const c of candidates) {
    const syn = typeof c === "string" ? c : c.syn;
    const display = typeof c === "string" ? c : c.display.replace(/\b\w/g, (x) => x.toUpperCase());
    const ck = fuzzKey(syn);
    if (ck.length < 3) continue;
    const d = ck === key ? 0 : distance(key, ck, max);
    if (d > max) continue;
    if (!best || d < best.d) {
      best = { d, display };
      tie = false;
    } else if (d === best.d && normalizeSearch(display) !== normalizeSearch(best.display)) tie = true;
  }
  if (!best || tie) return { name: raw, changed: false };
  return { name: best.display, changed: normalizeSearch(best.display) !== norm };
}

// Weak letters (alef, waw, ya, ha) are written many ways in Egyptian spelling ("مفيده" / "ميفيدا"), so Arabic names are
// also compared by their strong letters only.
const skeleton = (s) => fuzzKey(s).replace(/[اويه]/g, "");
const isArabic = (s) => /[؀-ۿ]/.test(s);

/**
 * Close spellings of known places: words the quick reader could not use ("مفيده", "ميڤيدا", "mivda", "palm hils") matched to
 * a known compound, developer or area. A word counts when it is one letter off (two for a long name) with the same first
 * letter, or when its strong Arabic letters are the same. Only one clear answer is taken; two different places that fit
 * equally well are reported as ambiguous, so the bot asks instead of guessing. Up to three words in a row make one name.
 * @param {string[]} words normalized words that nothing else used
 * @returns {{ matched: {typed, as, kind, key}[], ambiguous: {typed, options: string[]}[], used: Set<string> }}
 */
function closePlaces(words = []) {
  const matched = [];
  const ambiguous = [];
  const used = new Set();
  const ws = words.map((w) => String(w || ""));
  for (let size = 3; size >= 1; size--) {
    for (let i = 0; i + size <= ws.length; i++) {
      const slice = ws.slice(i, i + size);
      if (slice.some((w, k) => !w || used.has(i + k) || /\d/.test(w) || w.length < 3)) continue;
      const typed = slice.join(" ");
      const key = fuzzKey(typed);
      if (key.length < 5) continue;
      const arabic = isArabic(typed);
      const sk = arabic ? skeleton(typed) : "";
      const max = key.length >= 8 ? 2 : 1;
      let best = null;
      let options = [];
      for (const m of MATCHERS) {
        if (isArabic(m.norm) !== arabic) continue;
        const mk = fuzzKey(m.norm);
        if (mk.length < 4 || mk[0] !== key[0] || Math.abs(mk.length - key.length) > max) continue;
        let d = distance(key, mk, max);
        if (d > max && arabic && sk.length >= 3 && sk === skeleton(m.norm) && Math.abs(mk.length - key.length) <= 2) d = 1;
        if (d > max || m.norm === typed) continue;
        if (!best || d < best.d) {
          best = { d, kind: m.kind, key: m.key, as: m.norm };
          options = [m];
        } else if (d === best.d && !options.some((o) => o.kind === m.kind && o.key === m.key)) options.push(m);
      }
      if (!best) continue;
      for (let k = 0; k < size; k++) used.add(i + k);
      if (options.length > 1) ambiguous.push({ typed, options: options.slice(0, 3).map((o) => o.norm) });
      else matched.push({ typed, as: best.as, kind: best.kind, key: best.key });
    }
  }
  return { matched, ambiguous, used };
}

module.exports = { closePlaces, AREAS, DEVELOPERS, COMPOUNDS, synonymRows, findPlaces, resolvePlace, placeName, snapCompound };
