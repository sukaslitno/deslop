import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";
import arrowDown from "../../../assets/icons/ic16/arrow_down.svg?url";
import arrowLeft from "../../../assets/icons/ic16/arrow_left.svg?url";
import arrowRight from "../../../assets/icons/ic16/arrow_right.svg?url";
import arrowUp from "../../../assets/icons/ic16/arrow_up.svg?url";
import add from "../../../assets/icons/ic16/add.svg?url";
import automation from "../../../assets/icons/ic16/automation.svg?url";
import chat from "../../../assets/icons/ic16/chat.svg?url";
import check from "../../../assets/icons/ic16/check.svg?url";
import clean from "../../../assets/icons/ic16/clean.svg?url";
import copy from "../../../assets/icons/ic16/copy.svg?url";
import deleteIcon from "../../../assets/icons/ic16/delete.svg?url";
import donate from "../../../assets/icons/ic16/donate.svg?url";
import edit from "../../../assets/icons/ic16/edit.svg?url";
import folder from "../../../assets/icons/ic16/folder.svg?url";
import github from "../../../assets/icons/ic16/github.svg?url";
import info from "../../../assets/icons/ic16/info.svg?url";
import layers from "../../../assets/icons/ic16/layers.svg?url";
import refresh from "../../../assets/icons/ic16/refresh.svg?url";
import scan from "../../../assets/icons/ic16/scan.svg?url";
import settings from "../../../assets/icons/ic16/settings.svg?url";
import telegram from "../../../assets/icons/ic16/telegram.svg?url";
import time from "../../../assets/icons/ic16/time.svg?url";
import x from "../../../assets/icons/ic16/x.svg?url";
import add24 from "../../../assets/icons/ic24/add.svg?url";
import check24 from "../../../assets/icons/ic24/check.svg?url";
import x24 from "../../../assets/icons/ic24/x.svg?url";

/** The only icon inventory for product UI. Assets are bundled directly from /assets. */
export const iconAssets = {
  add,
  arrowDown,
  arrowLeft,
  arrowRight,
  arrowUp,
  automation,
  chat,
  check,
  clean,
  copy,
  delete: deleteIcon,
  donate,
  edit,
  folder,
  github,
  info,
  layers,
  refresh,
  scan,
  settings,
  telegram,
  time,
  x,
  add24,
  check24,
  x24,
} as const;

export type IconName = keyof typeof iconAssets;

type IconProps = Omit<ComponentProps<"span">, "children"> & {
  name: IconName;
  label?: string;
};

export function Icon({ name, label, className, style, ...props }: IconProps) {
  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cn("vc-icon inline-block shrink-0", className)}
      role={label ? "img" : undefined}
      style={{
        backgroundColor: "currentColor",
        maskImage: `url("${iconAssets[name]}")`,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain",
        WebkitMaskImage: `url("${iconAssets[name]}")`,
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        ...style,
      }}
      {...props}
    />
  );
}
