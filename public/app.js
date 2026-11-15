document.querySelectorAll('[data-toggle-password]').forEach(button => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.togglePassword);
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.textContent = visible ? 'Ocultar' : 'Mostrar';
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', visible ? 'Ocultar senha' : 'Mostrar senha');
  });
});
document.querySelectorAll('form').forEach(form => form.addEventListener('submit', () => {
  const button = form.querySelector('[type="submit"]');
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Aguarde…'; }
}));

const authorizationLink = document.querySelector('[data-payment-authorization]');
if (authorizationLink) window.location.replace(authorizationLink.href);
