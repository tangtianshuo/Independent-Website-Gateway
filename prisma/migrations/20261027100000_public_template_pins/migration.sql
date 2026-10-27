ALTER TABLE "TemplatePin"
  ADD COLUMN "imageRepository" TEXT,
  ADD COLUMN "manifestChecksum" TEXT,
  ADD COLUMN "sourceCommit" TEXT;
