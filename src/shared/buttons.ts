import { InlineKeyboard } from "grammy";
import { ACTIONS, UI_CONFIG } from "../config";
import { ForceChannel, BundleItem } from "../core/types";
import { t, getLocalizedOrdinals } from "../locales";

export type ButtonStyle = "primary" | "success" | "danger";

function styleLastButton(
  kb: InlineKeyboard,
  style?: ButtonStyle,
  customEmojiId?: string
): InlineKeyboard {
  const row = kb.inline_keyboard[kb.inline_keyboard.length - 1];
  const btn = (row?.[row.length - 1] as unknown) as Record<string, unknown> | undefined;
  if (!btn) return kb;
  if (style && UI_CONFIG.coloredButtons) {
    btn.style = style;
  }
  if (customEmojiId && UI_CONFIG.customEmojiIconsEnabled) {
    btn.icon_custom_emoji_id = customEmojiId;
  }
  return kb;
}

export function sanitizeInviteLink(rawLink?: string): string {
  if (!rawLink) return "";
  let link = rawLink.trim();
  if (link.startsWith("@")) {
    return `https://t.me/${link.slice(1)}`;
  }
  if (link.startsWith("+")) {
    return `https://t.me/+${link.slice(1)}`;
  }
  if (!link.startsWith("http://") && !link.startsWith("https://")) {
    link = `https://${link}`;
  }
  return link;
}

export class ButtonFactory {
  static empty(): InlineKeyboard {
    return new InlineKeyboard();
  }

  static getFirstAvailableOrdinal(usedLabels: Set<string>, lang: string = "en"): string {
    const ordinals = getLocalizedOrdinals(lang);
    for (const ordinal of ordinals) {
      if (!usedLabels.has(ordinal)) return ordinal;
    }
    return t(lang, "fj_ordinal_fallback", { n: usedLabels.size + 1 });
  }

  static forceJoinKeyboard(
    missingChannels: ForceChannel[],
    lang: string,
    code = "",
    verifyBtnText?: string
  ): InlineKeyboard {
    const kb = new InlineKeyboard();
    missingChannels.forEach((ch) => {
      const label = ch.button_text?.trim() || ch.channel_name;
      const url = sanitizeInviteLink(ch.invite_link);
      if (url) {
        kb.url(t(lang, "fj_join_btn", { label }), url).row();
      }
    });
    const verify = (verifyBtnText || "").trim() || t(lang, "btn_verify_join");
    kb.text(verify, `${ACTIONS.FORCE_JOIN_CHECK}${code}`);
    styleLastButton(kb, "success");
    return kb;
  }

  static deliveryKeyboard(
    lang: string,
    code: string,
    likes: number,
    dislikes: number,
    enableVoting: boolean,
    isAdmin = false,
    isProtected = false,
    next?: { count: number; offset: number } | null,
    isOneTimeFinal = false
  ): InlineKeyboard {
    const kb = new InlineKeyboard();

    if (next && next.count > 0) {
      kb.text(
        t(lang, "delivery_next_part", { count: next.count }),
        `${ACTIONS.CHUNK_DELIVERY}${code}:${next.offset}`
      );
      styleLastButton(kb, "primary");
      kb.row();
    }

    if (!isOneTimeFinal) {
      if (enableVoting) {
        kb.text(t(lang, "btn_vote_like", { count: likes }), `${ACTIONS.VOTE_LIKE}${code}`)
          .text(t(lang, "btn_vote_dislike", { count: dislikes }), `${ACTIONS.VOTE_DISLIKE}${code}`)
          .row();
      }

      kb.text(t(lang, "btn_redownload"), `${ACTIONS.REDOWNLOAD}${code}`);

      if (isAdmin) {
        kb.row();
        if (!isProtected) {
          kb.text(t(lang, "btn_protect_forward"), `${ACTIONS.MAKE_PROTECTED}${code}`);
        }
        kb.text(t(lang, "btn_delete_link"), `${ACTIONS.DELETE_CONFIRM_ASK}${code}`);
        styleLastButton(kb, "danger");
      }
    }

    return kb;
  }

  static hubKeyboard(
    lang: string,
    code: string,
    opts: {
      isProtected: boolean;
      isOwnerLocked?: boolean;
      expiryLabel?: string;
      isOneTime?: boolean;
      hasPasscode?: boolean;
      rotateIntLabel?: string;
    }
  ): InlineKeyboard {
    const kb = new InlineKeyboard()
      .text(t(lang, "hub_btn_test_dl"), `mng:testdl:${code}`).row()
      .text(t(lang, "hub_btn_review"), `mng:review:${code}`);
    styleLastButton(kb, "primary");
    kb.row();
    if (!opts.isProtected) {
      kb.text(t(lang, "btn_protect_forward"), `${ACTIONS.MAKE_PROTECTED}${code}`).row();
    }
    const lockText = opts.isOwnerLocked ? t(lang, "hub_btn_unlock_owner") : t(lang, "hub_btn_lock_owner");
    kb.text(lockText, `${ACTIONS.BUNDLE_LOCK_OWNER}${code}`);

    const oneTimeText = opts.isOneTime ? t(lang, "hub_btn_onetime_on") : t(lang, "hub_btn_onetime_off");
    kb.text(oneTimeText, `${ACTIONS.BUNDLE_ONETIME}${code}`).row();

    const expVal = opts.expiryLabel || t(lang, "label_disabled");
    kb.text(t(lang, "hub_btn_expiry", { val: expVal }), `${ACTIONS.BUNDLE_EXPIRY}${code}`);

    const passText = opts.hasPasscode ? t(lang, "hub_btn_pass_set") : t(lang, "hub_btn_pass_unset");
    kb.text(passText, `${ACTIONS.BUNDLE_PASS_PROMPT}${code}`).row();

    kb.text(t(lang, "hub_btn_post_channel"), `${ACTIONS.BUNDLE_POST_CHANNEL}${code}`);
    kb.text(t(lang, "hub_btn_rotate_now"), `${ACTIONS.BUNDLE_ROTATE_NOW}${code}`).row();

    const rotVal = opts.rotateIntLabel || t(lang, "label_disabled");
    kb.text(t(lang, "hub_btn_rotate_interval", { val: rotVal }), `${ACTIONS.BUNDLE_ROTATE_INT}${code}`).row();

    kb.text(t(lang, "hub_btn_delete_bundle"), `${ACTIONS.DELETE_CONFIRM_ASK}${code}`);
    styleLastButton(kb, "danger");
    return kb;
  }

  static channelPostKeyboard(lang: string, shareLink: string): InlineKeyboard {
    const kb = new InlineKeyboard();
    kb.url(t(lang, "btn_channel_download"), shareLink);
    styleLastButton(kb, "primary");
    return kb;
  }

  static reviewKeyboard(lang: string, code: string, items: BundleItem[]): InlineKeyboard {
    const kb = new InlineKeyboard();
    if (items.length < 10) {
      for (let index = 0; index < items.length; index++) {
        const fuid = items[index]?.file_unique_id || "";
        const fuidPrefix = fuid ? fuid.slice(0, 8) : "item";
        kb.text(
          t(lang, "review_btn_delete_item", { n: index + 1 }),
          `${ACTIONS.MANAGE_DEL_ITEM}${index}:${fuidPrefix}:${code}`
        );
        if ((index + 1) % 4 === 0) kb.row();
      }
      kb.row();
    }
    kb.text(t(lang, "review_refresh_btn"), `${ACTIONS.MANAGE_REFRESH}${code}`)
      .text(t(lang, "hub_btn_delete_bundle"), `${ACTIONS.DELETE_CONFIRM_ASK}${code}`);
    styleLastButton(kb, "danger");
    kb.row().text(t(lang, "btn_back_to_hub"), `${ACTIONS.MANAGE_HUB}${code}`);
    return kb;
  }

  static deleteConfirmKeyboard(lang: string, code: string): InlineKeyboard {
    const kb = new InlineKeyboard()
      .text(t(lang, "delete_confirm_yes"), `${ACTIONS.DELETE_CONFIRM_YES}${code}`);
    styleLastButton(kb, "danger");
    kb.text(t(lang, "delete_confirm_no"), `${ACTIONS.DELETE_CONFIRM_NO}${code}`);
    return kb;
  }

  static settingsKeyboard(
    lang: string,
    opts: {
      isOwner: boolean;
      isMaintActive: boolean;
      autoDelLabel: string;
      bundleTtlLabel: string;
      langLabel: string;
      isProtectActive: boolean;
    }
  ): InlineKeyboard {
    const kb = new InlineKeyboard()
      .text(t(lang, "btn_settings_daily_limit"), ACTIONS.SETTINGS_DAILY_LIMIT)
      .row()
      .text(t(lang, "btn_edit_bot_profile"), ACTIONS.BOT_PROFILE_MENU);

    if (opts.isOwner) {
      kb.row()
        .text(
          opts.isMaintActive ? t(lang, "btn_settings_maint_on") : t(lang, "btn_settings_maint_off"),
          ACTIONS.SETTINGS_MAINT
        );
      styleLastButton(kb, opts.isMaintActive ? "success" : "danger");
      kb.row()
        .text(t(lang, "btn_settings_autodel", { val: opts.autoDelLabel }), ACTIONS.SETTINGS_AUTODEL)
        .row()
        .text(t(lang, "btn_settings_bundle_ttl", { val: opts.bundleTtlLabel }), ACTIONS.SETTINGS_BUNDLE_TTL)
        .row()
        .text(t(lang, "btn_settings_lang", { lang: opts.langLabel }), ACTIONS.SETTINGS_LANG)
        .row()
        .text(
          opts.isProtectActive ? t(lang, "btn_settings_protect_on") : t(lang, "btn_settings_protect_off"),
          ACTIONS.SETTINGS_PROTECT
        );
    }
    return kb;
  }

  static profileKeyboard(lang: string): InlineKeyboard {
    return new InlineKeyboard()
      .text(t(lang, "profile_btn_change_name"), ACTIONS.BOT_PROFILE_SET_NAME).row()
      .text(t(lang, "profile_btn_change_desc"), ACTIONS.BOT_PROFILE_SET_DESC).row()
      .text(t(lang, "profile_btn_change_short_desc"), ACTIONS.BOT_PROFILE_SET_SHORT_DESC).row()
      .text(t(lang, "profile_btn_cancel"), ACTIONS.BOT_PROFILE_CANCEL);
  }

  static adminsKeyboard(
    lang: string,
    opts: {
      canAdd: boolean;
      removable: { user_id: number; role: string }[];
    }
  ): InlineKeyboard {
    const kb = new InlineKeyboard();
    if (opts.canAdd) {
      kb.text(t(lang, "admins_btn_add"), ACTIONS.ADMIN_ADD_PROMPT);
      styleLastButton(kb, "primary");
    }
    kb.text(t(lang, "admins_btn_refresh"), ACTIONS.ADMIN_REFRESH);
    for (const adm of opts.removable) {
      kb.row().text(
        t(lang, "admins_btn_remove", { id: String(adm.user_id), role: adm.role }),
        `${ACTIONS.ADMIN_DEL}${adm.user_id}`
      );
    }
    return kb;
  }

  static forceJoinAdminKeyboard(lang: string, channels: ForceChannel[], isAdmin: boolean): InlineKeyboard {
    const kb = new InlineKeyboard();
    if (channels.length === 0) {
      return kb.text(t(lang, "fj_menu_refresh"), ACTIONS.FJ_MENU_REFRESH);
    }
    for (const ch of channels) {
      kb.text(t(lang, "fj_menu_edit_name"), `${ACTIONS.FJ_EDIT_LABEL}${ch.channel_id}`)
        .text(t(lang, "btn_fj_stats"), `${ACTIONS.FJ_STATS}${ch.channel_id}`);
      if (isAdmin) {
        kb.text(t(lang, "fj_menu_delete"), `${ACTIONS.FJ_DELETE}${ch.channel_id}`);
        styleLastButton(kb, "danger");
      }
      kb.row();
      if (isAdmin && ch.is_active === 0) {
        kb.text(t(lang, "fj_menu_recheck"), `${ACTIONS.FJ_RECHECK}${ch.channel_id}`)
          .text(t(lang, "fj_menu_renew"), `${ACTIONS.FJ_RENEW}${ch.channel_id}`)
          .row();
      }
    }
    kb.text(t(lang, "fj_menu_refresh"), ACTIONS.FJ_MENU_REFRESH);
    return kb;
  }

  static vipsKeyboard(lang: string, hasVips: boolean): InlineKeyboard {
    const kb = new InlineKeyboard();
    kb.text(t(lang, "admins_btn_refresh"), ACTIONS.VIP_REFRESH);
    if (hasVips) {
      kb.text(t(lang, "btn_vips_clear_all"), ACTIONS.VIP_CLEAR_ASK);
      styleLastButton(kb, "danger");
    }
    return kb;
  }

  static vipsClearConfirmKeyboard(lang: string): InlineKeyboard {
    const kb = new InlineKeyboard()
      .text(t(lang, "btn_vips_confirm_yes"), ACTIONS.VIP_CLEAR_YES);
    styleLastButton(kb, "danger");
    kb.text(t(lang, "btn_vips_confirm_no"), ACTIONS.VIP_CLEAR_NO);
    return kb;
  }
}
