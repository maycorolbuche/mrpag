const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function emailLayout({ title, introduction, badge, tone = 'green', amount, dueDate, action, url, note, preview = false }) {
  const palette = {
    green: ['#e6f2e9', '#20563d'],
    amber: ['#fff3de', '#784800'],
    red: ['#fce9e5', '#8b3327'],
  };
  const [badgeBg, badgeColor] = palette[tone];
  const buttonStyle = 'display:inline-block;padding:14px 24px;border-radius:8px;background:#1d463a;color:#ffffff;font-size:15px;font-weight:bold;line-height:20px;text-decoration:none';
  const actionHtml = preview
    ? `<span style="${buttonStyle}">${escapeHtml(action)}</span>`
    : `<a href="${escapeHtml(url)}" style="${buttonStyle}">${escapeHtml(action)}</a>`;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · MR Pag</title></head>
<body style="margin:0;padding:0;background:#eef2ee;color:#203c34;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2ee">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#ffffff;border:1px solid #dfe7e0;border-radius:14px">
<tr><td style="padding:22px 26px;background:#15382f;color:#ffffff;border-radius:13px 13px 0 0;font-size:23px;font-weight:bold">MR Pag<span style="color:#c1ec92">.</span></td></tr>
<tr><td style="padding:26px">
${preview ? '<p style="margin:0 0 22px;padding:12px;background:#fff3de;color:#784800;font-size:13px;line-height:19px;border-radius:8px"><strong>E-mail de teste</strong> · Dados fictícios para visualizar o modelo.</p>' : ''}
<span style="display:inline-block;padding:6px 11px;border-radius:20px;background:${badgeBg};color:${badgeColor};font-size:12px;font-weight:bold">${escapeHtml(badge)}</span>
<h1 style="margin:15px 0 10px;font-size:28px;line-height:34px;color:#15382f">${escapeHtml(title)}</h1>
<p style="margin:0 0 22px;color:#456056;font-size:16px;line-height:25px">${escapeHtml(introduction)}</p>
${amount ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;background:#f2f6f0;border:1px solid #e0e9df;border-radius:10px">
<tr><td valign="top" width="58%" style="padding:16px 12px 16px 16px"><span style="color:#456056;font-size:12px">Valor</span><br><strong style="font-size:24px;line-height:32px;color:#15382f">${escapeHtml(amount)}</strong></td>
<td valign="top" style="padding:16px 12px 16px 0"><span style="color:#456056;font-size:12px">Vencimento</span><br><strong style="font-size:16px;line-height:32px;color:#15382f">${escapeHtml(dueDate)}</strong></td></tr></table>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td>${actionHtml}</td></tr></table>
${note ? `<p style="margin:16px 0 0;color:#456056;font-size:13px;line-height:20px">${escapeHtml(note)}</p>` : ''}
</td></tr>
<tr><td style="padding:16px 26px;border-top:1px solid #dfe7e0;color:#456056;font-size:12px;line-height:18px">Mensagem automática do MR Pag</td></tr>
</table></td></tr></table></body></html>`;
}
