import { Compass } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <Card>
        <EmptyState
          icon={Compass}
          title="Nothing lives at this address"
          description="The link may be from an older build. Calls are linked as #/calls/<call id>."
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/">Back to overview</Link>
            </Button>
          }
        />
      </Card>
    </>
  );
}
