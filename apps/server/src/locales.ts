/**
 * Template language: the language an organization works in. It decides which
 * language agents write in, the default language of chats, and the display
 * names the organization's template brought (departments, rooms, objects…).
 * Names are swapped only on exact matches, so anything the owner renamed stays.
 */
export const LANGUAGES = ["en", "vi"] as const;
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_NAME: Record<Language, string> = { en: "English", vi: "Vietnamese" };

/** Agents and personas default to this; a requester writing another language still gets answers in theirs. */
export const languageInstruction = (l: Language) =>
  l === "en" ? "" : `Work in ${LANGUAGE_NAME[l]}: write reports, team messages and deliverables in ${LANGUAGE_NAME[l]} unless the requester writes in another language or asks for one.`;

// English template names → their translations. Proper names (people, pets) are left alone.
const VI: Record<string, string> = {
  // coffee store
  "1A · Counter & seating": "1A · Quầy & chỗ ngồi", "1B · Coffee bar": "1B · Quầy pha chế", "1C · Kitchen": "1C · Bếp", "1D · Patio": "1D · Sân hiên",
  "2A · Office": "2A · Văn phòng", "2B · Roastery": "2B · Xưởng rang", "2C · Content studio": "2C · Phòng nội dung",
  "Autumn menu": "Thực đơn mùa thu", "Barista": "Pha chế", "Café table": "Bàn cà phê", "Cat": "Mèo", "Coffee bar": "Quầy pha chế",
  "Coffee roaster": "Máy rang cà phê", "Content studio": "Phòng nội dung", "Counter": "Quầy", "Espresso machine": "Máy espresso", "Fan": "Quạt",
  "Floor 1": "Tầng 1", "Floor 2": "Tầng 2", "Front of house": "Khu phục vụ", "Jukebox": "Máy hát", "Kitchen": "Bếp", "Management": "Quản lý",
  "Manager": "Người quản lý", "Music player": "Máy phát nhạc", "Oven": "Lò nướng", "Plant": "Cây cảnh", "Roaster": "Thợ rang", "Roastery": "Xưởng rang",
  "Shelf": "Kệ", "Shift supervisor": "Giám sát ca", "Shop cat": "Mèo của quán", "Social media": "Mạng xã hội", "Sofa": "Ghế sofa", "Viewer": "Người xem", "Neon sign": "Biển neon",
  "Order here": "Gọi món tại đây", "Menu": "Thực đơn", "Shop sign": "Biển hiệu", "Planning board": "Bảng kế hoạch", "Studio camera": "Máy quay studio", "Browser": "Trình duyệt",
  // what coffee things do
  "Wandering": "Đi dạo", "Napping": "Ngủ trưa", "Purring": "Rừ rừ", "Playing": "Đang chơi", "Pet": "Vuốt ve", "Play with": "Chơi cùng",
  "Ready": "Sẵn sàng", "Brewing": "Đang pha", "Pull a shot": "Pha một shot", "Paused": "Tạm dừng", "Pause the music": "Tắt nhạc",
  "Warm": "Giữ ấm", "Baking": "Đang nướng", "Bake a batch": "Nướng một mẻ", "Cooling": "Đang nguội", "Roasting": "Đang rang", "Roast a batch": "Rang một mẻ",
  "On": "Bật", "Off": "Tắt", "Switch off": "Tắt đi", "Dimmed": "Dịu đèn", "Dim the light": "Giảm đèn", "Standby": "Chờ", "Recording": "Đang quay",
  "Record a clip": "Quay một đoạn", "Open": "Mở cửa", "Closed": "Đóng cửa",
  // factory
  "Line A": "Dây chuyền A", "Line B": "Dây chuyền B", "Logistics": "Hậu cần", "Maintenance": "Bảo trì", "Plant management": "Quản lý nhà máy",
  "Production": "Sản xuất", "Quality": "Chất lượng", "Shift lead": "Trưởng ca",
  // hospital
  "Administration": "Hành chính", "Admissions": "Tiếp nhận", "Head nurse": "Điều dưỡng trưởng", "Medical records": "Hồ sơ bệnh án",
  "Outpatient clinic": "Phòng khám ngoại trú", "Pharmacy supply": "Cung ứng dược", "Scheduling": "Lịch hẹn", "Ward 3": "Khoa 3",
  // lab
  "Data & analysis": "Dữ liệu & phân tích", "Grant 2026": "Tài trợ 2026", "Lab operations": "Vận hành phòng lab", "PI office": "Phòng trưởng nhóm",
  "Paper in progress": "Bài báo đang viết", "Postdoc": "Nghiên cứu sau tiến sĩ", "Research": "Nghiên cứu",
  // company (install default)
  "Admin": "Quản trị", "Engineering": "Kỹ thuật", "Engineering manager": "Quản lý kỹ thuật", "Executive": "Điều hành",
  "Marketing website": "Website marketing", "Operations": "Vận hành", "Product": "Sản phẩm", "Reviewer": "Người duyệt",
};
export const DICTS: Record<Language, Record<string, string>> = { en: {}, vi: VI };
const TEXT_FIELDS = new Set(["name", "title", "label"]);

/** The same document with template names moved from one language to another. */
export function translateNames<T>(doc: T, from: Language, to: Language): T {
  if (from === to) return doc;
  const toEn = Object.fromEntries(Object.entries(DICTS[from]).map(([en, x]) => [x, en]));
  const map = (s: string) => DICTS[to][toEn[s] ?? s] ?? toEn[s] ?? s;
  // Chat templates are keyed by title: their keys follow the titles they belong to.
  const walk = (v: unknown, parent = ""): unknown =>
    Array.isArray(v) ? v.map((x) => walk(x))
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [parent === "chatTemplates" ? map(k) : k, TEXT_FIELDS.has(k) && typeof x === "string" ? map(x) : walk(x, k)]))
    : v;
  return walk(doc) as T;
}
