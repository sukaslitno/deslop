import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";
import arrowDown from "../../../assets/icons/ic16/arrow_down.svg?no-inline";
import arrowLeft from "../../../assets/icons/ic16/arrow_left.svg?no-inline";
import arrowRight from "../../../assets/icons/ic16/arrow_right.svg?no-inline";
import arrowUp from "../../../assets/icons/ic16/arrow_up.svg?no-inline";
import add from "../../../assets/icons/ic16/add.svg?no-inline";
import automation from "../../../assets/icons/ic16/automation.svg?no-inline";
import chat from "../../../assets/icons/ic16/chat.svg?no-inline";
import check from "../../../assets/icons/ic16/check.svg?no-inline";
import clean from "../../../assets/icons/ic16/clean.svg?no-inline";
import copy from "../../../assets/icons/ic16/copy.svg?no-inline";
import deleteIcon from "../../../assets/icons/ic16/delete.svg?no-inline";
import donate from "../../../assets/icons/ic16/donate.svg?no-inline";
import edit from "../../../assets/icons/ic16/edit.svg?no-inline";
import folder from "../../../assets/icons/ic16/folder.svg?no-inline";
import github from "../../../assets/icons/ic16/github.svg?no-inline";
import info from "../../../assets/icons/ic16/info.svg?no-inline";
import layers from "../../../assets/icons/ic16/layers.svg?no-inline";
import refresh from "../../../assets/icons/ic16/refresh.svg?no-inline";
import scan from "../../../assets/icons/ic16/scan.svg?no-inline";
import settings from "../../../assets/icons/ic16/settings.svg?no-inline";
import telegram from "../../../assets/icons/ic16/telegram.svg?no-inline";
import time from "../../../assets/icons/ic16/time.svg?no-inline";
import x from "../../../assets/icons/ic16/x.svg?no-inline";
import add24 from "../../../assets/icons/ic24/add.svg?no-inline";
import check24 from "../../../assets/icons/ic24/check.svg?no-inline";
import x24 from "../../../assets/icons/ic24/x.svg?no-inline";

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
