"use client";

import { CheckCircle2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  mode: "signed-in" | "signed-up";
  onContinue: () => void;
}

export function WelcomeDialog({ open, onOpenChange, name, mode, onContinue }: Props) {
  const title = mode === "signed-up" ? "Account created" : "Welcome back";
  const description =
    mode === "signed-up"
      ? "Your workspace is ready. Let's stress-test your first floor plan."
      : "You're signed in and ready to keep testing your floor plans.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="text-center sm:text-left">
        <DialogHeader className="items-center sm:items-start">
          <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-primary/15 text-primary">
            <CheckCircle2 className="size-6" />
          </div>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === "signed-up" ? "Welcome" : "Good to see you again"}, {name}. {description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onContinue} className="w-full sm:w-auto">
            Go to dashboard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
