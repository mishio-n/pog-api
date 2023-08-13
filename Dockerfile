FROM public.ecr.aws/lambda/nodejs:16 as builder
WORKDIR /usr/app
COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npx prisma generate && \
    npm run build

FROM public.ecr.aws/lambda/nodejs:16

WORKDIR ${LAMBDA_TASK_ROOT}

ENV NODE_TLS_REJECT_UNAUTHORIZED=0

COPY --from=builder /usr/app/dist/* ./
COPY --from=builder /usr/app/prisma ./prisma
COPY --from=builder /usr/app/node_modules ./node_modules

CMD ["index.handler"]
