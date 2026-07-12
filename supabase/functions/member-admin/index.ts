// member-admin — ações administrativas sobre membros que exigem service role.
//
// Hoje: reforçar a DESATIVAÇÃO de um membro. O flip de profiles.is_active e a
// auditoria ficam na RPC set_member_active (chamada direto pelo frontend); aqui
// só fazemos a mitigação que precisa de privilégio de admin do Auth: banir o
// usuário no GoTrue para que suas sessões não sejam renovadas (o access token
// stateless segue válido até expirar — limitação conhecida, documentada na
// migration 20260712220000). Ao reativar, removemos o ban.
//
// Só admin da MESMA org do alvo pode chamar (checado no servidor).

import { requireUser, admin, json, cors, reportError } from '../_shared/base.ts'

const BAN_FOREVER = '876600h' // ~100 anos

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { user, orgId, role } = await requireUser(req)
    if (role !== 'admin') return json({ error: 'Apenas administradores.' }, 403)

    const body = await req.json().catch(() => ({})) as { user_id?: string; active?: boolean; action?: string }
    const targetId = body.user_id
    if (!targetId) return json({ error: 'user_id obrigatório.' }, 400)
    if (targetId === user.id) return json({ error: 'Você não pode desativar a si mesmo.' }, 400)

    // Alvo precisa ser da mesma org do admin (nunca confie no cliente).
    const db = admin()
    const { data: target } = await db
      .from('profiles').select('org_id').eq('id', targetId).single()
    if (!target || target.org_id !== orgId) {
      return json({ error: 'Usuário não encontrado na sua organização.' }, 404)
    }

    // active === true → reativar (remove ban); qualquer outro valor → desativar (banir)
    const reactivate = body.active === true || body.action === 'unban'
    const { error } = await db.auth.admin.updateUserById(targetId, {
      ban_duration: reactivate ? 'none' : BAN_FOREVER,
    })
    if (error) return json({ error: error.message }, 500)

    return json({ ok: true, banned: !reactivate })
  } catch (e) {
    // requireUser lança uma Response de erro em falha de auth
    if (e instanceof Response) return e
    console.error('member-admin erro:', e)
    await reportError(e, 'member-admin')
    return json({ error: 'Erro interno.' }, 500)
  }
})
