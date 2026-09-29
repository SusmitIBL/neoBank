import { api, $, onSubmit } from '/shared/ui.js';

onSubmit($('#user-login'), async (data) => {
  await api('POST', '/api/login', data);
  location.href = '/corporate.html';
});

onSubmit($('#admin-login'), async (data) => {
  await api('POST', '/api/admin/login', data);
  location.href = '/admin.html';
});

onSubmit($('#bank-login'), async () => {
  const { bankUrl } = await api('GET', '/api/config');
  location.href = bankUrl + '/';
});
