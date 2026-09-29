import { api, $, onSubmit } from '/shared/ui.js';

onSubmit($('#login'), async (data) => {
  await api('POST', '/api/login', data);
  location.href = '/admin.html';
});
