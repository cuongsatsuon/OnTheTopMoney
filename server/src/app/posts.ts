// Bài soạn tay (Story 6.1, AD-13). Route dưới /api/v1 → guard auth đã yêu cầu phiên; ghi kiểm Origin (AD-19).
// Nghiệp vụ ở `content`; route parse + mở transaction (bài và mọi target cùng có hoặc cùng không).
// - `POST /posts`: tạo nháp (1 post + n target `draft`); `PUT /posts/:id`: thay toàn bộ đích của nháp;
// - `GET /posts/:id`: đọc lại để mở nháp ở Soạn bài (`/soan-bai?bai=<id>`).
import { SavePostRequest, type PostDto } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createPost, getPost, updateDraftPost } from '../modules/content/index.ts'
import type { Db } from '../platform/db/index.ts'
import { AppError } from '../platform/errors/index.ts'

const IdParams = z.object({ id: z.uuid() })

export interface PostsDeps {
  db: Db
}

export function registerPosts(app: FastifyInstance, deps: PostsDeps): void {
  const { db } = deps

  app.post('/api/v1/posts', async (req, reply): Promise<PostDto> => {
    const input = SavePostRequest.parse(req.body ?? {})
    const post = await db.transaction((tx) => createPost(tx, { source: 'manual', ...input }))
    return reply.code(201).send(post)
  })

  app.get('/api/v1/posts/:id', async (req): Promise<PostDto> => {
    const { id } = IdParams.parse(req.params)
    const post = await getPost(db, id)
    if (!post) throw new AppError('NOT_FOUND', 404, { message: 'Bài không tồn tại', details: { postId: id } })
    return post
  })

  app.put('/api/v1/posts/:id', async (req): Promise<PostDto> => {
    const { id } = IdParams.parse(req.params)
    const input = SavePostRequest.parse(req.body ?? {})
    return db.transaction((tx) => updateDraftPost(tx, id, input))
  })
}
