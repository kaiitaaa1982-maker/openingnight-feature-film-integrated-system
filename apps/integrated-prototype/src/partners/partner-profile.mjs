// 取引先の請求・連絡先情報（版で持つ）。検証は純関数。締日・支払サイトは取引ライン（取引先×流通×取引区分）の
// 属性なのでここでは扱わない。口座番号などの機微な情報は持たない。
export const PARTNER_ROLES = Object.freeze({
  customer: '得意先（売上の相手）', supplier: '仕入先（支払の相手）', rights_holder: '権利元', broadcaster: '放送局', agency: '代理店',
});

// 法人番号の検査数字（先頭1桁）。個人事業者の登録番号は別の採番のため、不一致は警告にとどめる。
export function corporateCheckDigitOk(digits13) {
  if (!/^\d{13}$/.test(digits13)) return false;
  const body = digits13.slice(1);
  let sum = 0;
  for (let n = 1; n <= 12; n += 1) {
    const digit = Number(body[12 - n]);
    sum += digit * (n % 2 === 1 ? 1 : 2);
  }
  return Number(digits13[0]) === 9 - (sum % 9);
}

const clean = (value, max) => {
  if (value === null || value === undefined) return null;
  const text = String(value).normalize('NFKC').trim();
  if (!text) return null;
  if (text.length > max) throw new Error(`${max}文字以内にしてください`);
  return text;
};

export function normalizeProfile(input = {}) {
  const errors = [];
  const warnings = [];
  const out = {};
  const field = (key, label, max, check) => {
    try {
      const value = clean(input[key], max);
      if (value && check) {
        const problem = check(value);
        if (problem) { errors.push({field: key, message: `${label}: ${problem}`}); return; }
      }
      out[key] = value;
    } catch (error) {
      errors.push({field: key, message: `${label}は${error.message}`});
    }
  };
  const roles = Array.isArray(input.roles) ? [...new Set(input.roles)] : [];
  const unknown = roles.filter((role) => !PARTNER_ROLES[role]);
  if (unknown.length) errors.push({field: 'roles', message: `取引の区分に不明な値があります: ${unknown.join('、')}`});
  out.roles = roles.filter((role) => PARTNER_ROLES[role]);
  field('invoice_registration_number', 'インボイス登録番号', 14, (value) => {
    const v = value.toUpperCase().replace(/[\s-]/g, '');
    if (!/^T\d{13}$/.test(v)) return '「T」と13桁の数字で入れてください（例: T1234567890123）';
    out.__invoice = v;
    if (!corporateCheckDigitOk(v.slice(1))) warnings.push('インボイス登録番号の検査数字が法人番号の規則と合いません（個人事業者の番号なら問題ありません。国税庁の公表サイトで確かめてください）');
    return null;
  });
  if (out.__invoice) { out.invoice_registration_number = out.__invoice; delete out.__invoice; }
  field('postal_code', '郵便番号', 8, (value) => (/^\d{3}-?\d{4}$/.test(value) ? null : '「123-4567」の形で入れてください'));
  field('address', '住所', 300);
  field('phone', '電話番号', 30, (value) => (/^[\d()+\-\s]{6,30}$/.test(value) ? null : '数字とハイフンで入れてください'));
  field('contact_name', '担当者', 100);
  field('contact_email', '連絡先メール', 200, (value) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : 'メールアドレスの形になっていません'));
  field('billing_note', '請求の備考', 1000);
  const from = clean(input.effective_from, 10);
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) errors.push({field: 'effective_from', message: '適用開始日は「2026-10-01」の形で入れてください'});
  out.effective_from = from;
  return {values: out, errors, warnings};
}
