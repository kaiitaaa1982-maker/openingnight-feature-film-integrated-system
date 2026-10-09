import {WORK_FIELDS,MONEY_FIELDS} from './work-master-model.mjs';
import {PRODUCT_FIELDS,PRODUCT_MONEY_FIELDS} from './product-master-model.mjs';
export const MASTER_TABLE_LABELS={
  work_master_profile_versions:'作品の仕様（版）', work_finance_versions:'作品の費用（版）', work_contracts:'作品の契約', work_contract_set_versions:'作品の契約一覧（版）',work_contract_versions:'作品の契約の内容（版）',work_rights_versions:'作品の権利元一覧（版）',work_rights_party_versions:'作品の権利元の明細（版）',product_master_profile_versions:'商品の仕様（版）',
};
export const MASTER_TABLE_MEANINGS={
  work_master_profile_versions:'既存カタログ・提案情報に無い作品の仕様。シリーズ・レーベル・製作区分・仮登録・権利処理の確認原文。フリガナ等を複写しない。',
  work_finance_versions:'金額ごとに税区分・確定状態・評価日・根拠を持つ費用。委員会は条件版への参照のみ。総事業費と宣伝実績は保存しない。',
  work_contracts:'作品内で契約を継続して識別するキー。MG契約は既存MGへのリンクだけで複製しない。',
  work_contract_set_versions:'複数契約の並びを固定する版。新しい版で契約を外しても過去の内容は残る。',
  work_contract_versions:'契約ごとの種類・相手・締結日・開始日・終了日・根拠文書と順序。契約一覧の版に従属する。',
  work_rights_versions:'複数の権利元を一組として保存する版。空の版で全行の撤回を記録できる。',
  work_rights_party_versions:'順番・取引先または名前・役割・任意の権利範囲・根拠。権利元を固定の列数に制限しない。',
  product_master_profile_versions:'品番・JAN・発売販売元・価格と税区分・発売日・製品仕様の版。商品IDと品番を区別し、既存の商品配賦を変えない。',
};
export const MASTER_COLUMN_LABELS={...WORK_FIELDS,...PRODUCT_FIELDS,
  org_id:'組織',work_id:'作品',product_id:'商品',revision:'版の連番',source_reference:'出所・根拠',reason:'改訂理由',created_by:'版の作成者',created_at:'版の作成日時',
  committee_term_version_id:'参照する委員会の条件版',self_partner_id:'自社を表す取引先（保存時）',contract_key:'作品内の契約キー',position:'表示順',kind:'契約の種類',signed_on:'契約締結日',starts_on:'契約開始日',ends_on:'契約終了日',partner_id:'相手の取引先',document_reference:'根拠の文書',rights_scope:'権利の範囲',evidence:'根拠',role:'権利元の役割',name:'名称・表記',title:'契約名',
  ...Object.fromEntries(Object.entries({...MONEY_FIELDS,...PRODUCT_MONEY_FIELDS}).flatMap(([k,label])=>[['yen','金額（円）'],['tax_basis','税区分'],['status','確定状態'],['as_of','評価日'],['evidence','根拠']].map(([suffix,meaning])=>[`${k}_${suffix}`,`${label}：${meaning}`]))),
};
export const MASTER_COLUMN_MEANINGS=Object.fromEntries(Object.entries(MASTER_COLUMN_LABELS).map(([k,label])=>[k,`${label}。${k.endsWith('_yen')?'非負の円整数。空は未確認、0円とは区別。':k.endsWith('_tax_basis')?'unknown=未確認、ex_tax=税別、inc_tax=税込。':k.endsWith('_status')?'unknown=未確認、estimated=見込み、confirmed=確定。':k.endsWith('_as_of')?'金額の評価時点（ISO日付）。':k==='jan_code'?'文字列で先頭0を保持。':k==='revision'?'組織・対象ごとに1からの連番。変更削除は不可。':'組織内の版の内容として保持。'}`]));
