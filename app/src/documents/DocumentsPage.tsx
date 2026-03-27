import { useState } from "react";

import { Button } from "../client/components/ui/button";
import { DocumentTemplatesSection } from "./DocumentTemplatesSection";
import { SubmissionsTable } from "./SubmissionsTable";

type DashboardTab = "templates" | "submissions";

export default function DocumentsPage() {
  const [tab, setTab] = useState<DashboardTab>("templates");

  return (
    <div className="bg-background/50 flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden">
      <div className="from-primary/[0.03] via-background to-background relative shrink-0 border-b border-border/60 bg-gradient-to-br px-4 py-5 md:px-8 md:py-6">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
          <div className="flex min-w-0 items-start gap-4">
            <div
              className="from-primary to-primary/60 mt-1 hidden h-14 w-1.5 shrink-0 rounded-full bg-gradient-to-b shadow-sm sm:block"
              aria-hidden
            />
            <div>
              <h1 className="text-foreground text-3xl font-bold tracking-tight md:text-4xl">
                Dashboard
              </h1>
              <p
                className="text-muted-foreground mt-2 max-w-full text-sm md:text-base whitespace-nowrap overflow-x-auto [scrollbar-width:thin]"
                title="Organize templates in folders, send for signing, and track submissions — use the full workspace below."
              >
                Organize templates in folders, send for signing, and track submissions — use the full workspace below.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <Button
              type="button"
              variant={tab === "templates" ? "default" : "outline"}
              size="lg"
              className="h-11 min-h-11 w-full justify-center px-6 sm:min-w-[12rem]"
              onClick={() => setTab("templates")}
            >
              Document templates
            </Button>
            <Button
              type="button"
              variant={tab === "submissions" ? "default" : "outline"}
              size="lg"
              className="h-11 min-h-11 w-full justify-center px-6 sm:min-w-[12rem]"
              onClick={() => setTab("submissions")}
            >
              Submissions
            </Button>
          </div>
        </div>
      </div>

      <main className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col px-4 py-4 md:px-8 md:py-5">
        {tab === "templates" ? (
          <DocumentTemplatesSection />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="shrink-0">
              <h2 className="text-foreground text-lg font-semibold tracking-tight md:text-xl">
                Sent for signing
              </h2>
              <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
                Templates you sent from the editor appear here with status.
                Scroll inside the list when you have many submissions.
              </p>
            </div>
            <SubmissionsTable />
          </div>
        )}
      </main>
    </div>
  );
}
