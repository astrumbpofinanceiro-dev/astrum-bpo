-- 0017 — Etiquetas: código livre (ex.: "Medicina XXVII – Bruna") que agrupa várias operações
-- do mesmo contrato. Uma etiqueta por operação; uma etiqueta pode estar em muitas operações.

ALTER TABLE tags ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE tags ADD CONSTRAINT tags_tenant_id_key UNIQUE (tenant_id, id);
ALTER TABLE tags ADD CONSTRAINT tags_color_hex CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');
CREATE UNIQUE INDEX uq_tags_name ON tags (tenant_id, lower(name));

ALTER TABLE economic_operations ADD COLUMN tag_id uuid;
ALTER TABLE economic_operations ADD FOREIGN KEY (tenant_id, tag_id) REFERENCES tags (tenant_id, id);
CREATE INDEX idx_ops_tag ON economic_operations (tenant_id, tag_id) WHERE tag_id IS NOT NULL;
