-- 0004: 导入件再分享溯源转发（spec 2026-07-22-prompt-share-reshare-redirect）。
-- borrowed=1 = 「导入件转发原码」的开关状态行：code 指向原作者的码，本人没铸过码。
-- code 唯一性只对自有码成立——borrowed 行与原作者行同码共存，唯一索引改 partial。
ALTER TABLE prompt_shares ADD COLUMN borrowed INTEGER NOT NULL DEFAULT 0;
DROP INDEX idx_prompt_shares_code;
CREATE UNIQUE INDEX idx_prompt_shares_code ON prompt_shares(code) WHERE borrowed = 0;
