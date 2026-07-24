-- Integração Microsoft/Outlook (FASE 6)
-- A constraint integrations_type_check não permitia type='microsoft', então o
-- microsoft-oauth não conseguia gravar a linha da integração (o INSERT era
-- recusado calado) e o callback caía em "Sessão de conexão expirada".
-- Aqui adicionamos 'microsoft' aos tipos válidos.
alter table integrations drop constraint if exists integrations_type_check;
alter table integrations add constraint integrations_type_check check (type in (
  'google_calendar','whatsapp_evolution','whatsapp_zapi',
  'gmail','slack','rd_station','webhook','voip','microsoft'
));
