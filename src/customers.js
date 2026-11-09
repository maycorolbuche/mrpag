const states = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));
export const emptyCustomer = { person_type: 'person', name: '', trade_name: '', document: '', email: '', phone: '', postal_code: '', street: '', number: '', complement: '', neighborhood: '', city: '', state: '', notes: '', active: 1 };
const limits = { name: 150, trade_name: 150, email: 254, street: 150, number: 20, complement: 100, neighborhood: 100, city: 100, notes: 2000 };
export function validDocument(value, type) {
  if (/^(\d)\1+$/.test(value)) return false;
  if (type === 'person') {
    if (value.length !== 11) return false;
    for (let size = 9; size <= 10; size++) {
      const sum = [...value.slice(0,size)].reduce((total, digit, i) => total + Number(digit)*(size+1-i), 0);
      const digit = (sum*10)%11;
      if (Number(value[size]) !== (digit === 10 ? 0 : digit)) return false;
    }
    return true;
  }
  if (value.length !== 14) return false;
  for (let size = 12; size <= 13; size++) {
    let weight = size-7, sum = 0;
    for (let i=0; i<size; i++) { sum += Number(value[i])*weight; weight--; if (weight===1) weight=9; }
    const remainder = sum%11;
    if (Number(value[size]) !== (remainder < 2 ? 0 : 11-remainder)) return false;
  }
  return true;
}
export function validateCustomer(body) {
  const customer = { ...emptyCustomer };
  const errors = {};
  for (const [field,max] of Object.entries(limits)) {
    const value = (body[field] || '').trim();
    customer[field] = value;
    if (value.length > max) errors[field] = `Use no máximo ${max} caracteres.`;
  }
  if (customer.name.length < 2) errors.name = 'Informe um nome com pelo menos 2 caracteres.';
  customer.person_type = body.person_type;
  if (!['person','company'].includes(customer.person_type)) errors.person_type = 'Selecione pessoa física ou jurídica.';
  customer.email = customer.email.toLowerCase();
  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) errors.email = 'Informe um e-mail válido.';
  for (const field of ['document','phone','postal_code']) {
    const input = (body[field] || '').trim();
    customer[field] = input.replace(/\D/g,'');
    if (input && (!customer[field] || /[^\d\s().+\-/]/.test(input))) errors[field] = 'Use apenas números e formatação válida.';
  }
  if (customer.document && !validDocument(customer.document, customer.person_type)) errors.document = 'Informe um CPF/CNPJ válido e correspondente ao tipo de pessoa.';
  if (customer.phone && (customer.phone.length < 8 || customer.phone.length > 15)) errors.phone = 'Informe um telefone com 8 a 15 dígitos, incluindo DDD.';
  if (customer.postal_code && customer.postal_code.length !== 8) errors.postal_code = 'Informe um CEP com 8 dígitos.';
  customer.state = (body.state || '').trim().toUpperCase();
  if (customer.state && !states.has(customer.state)) errors.state = 'Selecione uma UF válida.';
  customer.active = body.active === '1' ? 1 : 0;
  if (!['0','1'].includes(body.active)) errors.active = 'Selecione uma situação válida.';
  return { customer, errors };
}
const columns = Object.keys(emptyCustomer);
export function customerStatement(db, customer, accountId, id = null) {
  const values = columns.map(column => column === 'document' ? customer[column] || null : customer[column]);
  const now = Date.now();
  if (id !== null) return db.prepare(`UPDATE customers SET ${columns.map(c=>`${c}=?`).join(',')},updated_at=? WHERE id=? AND account_id=? RETURNING id`).bind(...values, now, id, accountId);
  return db.prepare(`INSERT INTO customers(account_id,${columns.join(',')},created_at,updated_at) VALUES (${Array(columns.length+3).fill('?').join(',')}) RETURNING id`).bind(accountId,...values,now,now);
}
export async function customerRoutes({ request, url, db, user, account, body, show, redirect }) {
  const path = url.pathname;
  const isList = path === '/customers';
  const isNew = path === '/customers/new';
  const match = path.match(/^\/customers\/([1-9]\d{0,14})(?:\/(edit|update|status))?$/);
  if (!isList && !isNew && !match) return null;
  const notFound = () => show('auth', { page: 'error', error: 'Cliente não encontrado.' }, 404);
  const invalidMethod = () => show('auth', { page: 'error', error: 'Método não permitido.' }, 405);
  let existing = null;
  if (match) {
    existing = await db.prepare('SELECT * FROM customers WHERE id=? AND account_id=?').bind(Number(match[1]),user.account_id).first();
    if (!existing) return notFound();
  }
  if (isList && request.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().slice(0,150);
    const status = ['0','1'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : '';
    const clauses = ['account_id=?'], params = [user.account_id];
    if (status !== '') { clauses.push('active=?'); params.push(Number(status)); }
    if (q) {
      clauses.push("(name LIKE ? ESCAPE '\\' OR trade_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR document LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')");
      const escaped = q.replace(/[\\%_]/g,'\\$&');
      const digits = q.replace(/\D/g,'');
      params.push(...Array(3).fill(`%${escaped}%`), `%${digits || escaped}%`, `%${digits || escaped}%`);
    }
    const where = clauses.join(' AND ');
    const { total } = await db.prepare(`SELECT count(*) total FROM customers WHERE ${where}`).bind(...params).first();
    const pages = Math.max(1,Math.ceil(total/20));
    const page = Math.min(pages,Math.max(1,parseInt(url.searchParams.get('page'),10)||1));
    const rows = await db.prepare(`SELECT id,name,person_type,document,email,phone,active FROM customers WHERE ${where} ORDER BY name COLLATE NOCASE,id LIMIT 20 OFFSET ?`).bind(...params,(page-1)*20).all();
    return show('customers', { customers: rows.results, filters: { q, status }, pagination: { page, pages, total } });
  }
  if (isNew && request.method === 'GET') return show('customer-form', { customer: emptyCustomer, errors: {}, editing: false });
  if (match && !match[2] && request.method === 'GET') return show('customer-detail', { customer: existing });
  if (match?.[2] === 'edit' && request.method === 'GET') return show('customer-form', { customer: existing, errors: {}, editing: true });
  if ((isList || match?.[2] === 'update') && request.method === 'POST') {
    const { customer, errors } = validateCustomer(body);
    if (customer.document) {
      const duplicate = await db.prepare('SELECT id FROM customers WHERE account_id=? AND document=? AND id<>?').bind(user.account_id,customer.document,existing?.id||0).first();
      if (duplicate) errors.document = 'Este CPF/CNPJ já está cadastrado na sua conta.';
    }
    const invalid = () => show('customer-form', { customer: { ...customer, id: existing?.id }, errors, editing: !!existing }, 422);
    if (Object.keys(errors).length) return invalid();
    try {
      const saved = await customerStatement(db,customer,user.account_id,existing?.id??null).first();
      if (!saved) return notFound();
      return redirect(`/customers/${saved.id}?saved=1`);
    } catch(error) {
      if (!String(error.message).includes('UNIQUE constraint failed: customers.account_id, customers.document')) throw error;
      errors.document = 'Este CPF/CNPJ já está cadastrado na sua conta.';
      return invalid();
    }
  }
  if (match?.[2] === 'status' && request.method === 'POST') {
    if (!['0','1'].includes(body.active)) return show('auth', { page: 'error', error: 'Situação inválida.' }, 422);
    await db.prepare('UPDATE customers SET active=?,updated_at=? WHERE id=? AND account_id=?').bind(Number(body.active),Date.now(),existing.id,user.account_id).run();
    return redirect(`/customers/${existing.id}?saved=1`);
  }
  return invalidMethod();
}
