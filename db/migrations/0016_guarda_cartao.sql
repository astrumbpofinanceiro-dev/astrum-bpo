-- 0016 — Extrato bancário não pode entrar em conta de cartão corporativo.
-- A fatura do cartão é paga por débito bancário conciliado N:1 com as compras (Doc 3);
-- importar o extrato do cartão como movimentação bancária travaria o fechamento e
-- conciliaria o mesmo gasto duas vezes.

CREATE FUNCTION app.trg_no_card_bank_tx() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM financial_accounts
              WHERE tenant_id = NEW.tenant_id AND id = NEW.financial_account_id
                AND account_type = 'CORPORATE_CARD') THEN
    RAISE EXCEPTION 'CARD_ACCOUNT_BANK_STATEMENT' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER no_card_bank_tx BEFORE INSERT OR UPDATE OF financial_account_id ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION app.trg_no_card_bank_tx();
