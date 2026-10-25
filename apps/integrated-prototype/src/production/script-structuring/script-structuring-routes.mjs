import {readScriptArtifact, readScriptOriginal, readWorkProject} from '../production-store.mjs';

// 台本の構造化画面の受け口。左に描く原本（保存した元のファイル）を、作品への権限がある人にだけ返す（FR-PROD-STRUCT-007）。
// 原本が無い・別の組織・台本でない原本（売上報告など）・権限の無い作品は、どれも同じ 403 にする（ほかの台本の受け口と同じく、有無を見せない）。
// 本体（R2 に置いた original_base64）は、権限を確かめてから読む。
export function registerScriptStructuringRoutes(app, {db, bad, permittedProjects}) {
  if (!app || !db || typeof bad !== 'function' || typeof permittedProjects !== 'function') throw new Error('script structuring routes require app, db, bad and permittedProjects');
  app.get('/api/workflow/scripts/:artifactId/original', async (c) => {
    const identity = c.get('identity');
    const artifactId = Number(c.req.param('artifactId'));
    if (!/^\d+$/.test(c.req.param('artifactId')) || !Number.isSafeInteger(artifactId) || artifactId <= 0) return bad(c, '原本の番号を確かめてください', 400);
    const artifact = await readScriptArtifact(db, identity.org_id, artifactId);
    const work = artifact ? await readWorkProject(db, identity.org_id, artifact.work_id) : null;
    const allowed = work ? new Set((await permittedProjects(db, identity, false)).map((row) => Number(row.id))) : new Set();
    if (!artifact || !work || !allowed.has(Number(work.project_id))) return bad(c, '台本原本への権限がありません', 403);
    const original = await readScriptOriginal(db, identity.org_id, artifactId);
    if (!original) return bad(c, '台本原本への権限がありません', 403);
    c.header('Cache-Control', 'private, no-store');
    return c.json({ok: true, artifactId, fileName: original.file_name, mediaType: original.media_type || null, rawHash: original.raw_sha256, base64: original.original_base64});
  });
}
