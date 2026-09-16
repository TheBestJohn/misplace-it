import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../api/endpoints'
import { grams } from '../lib/format'
import { Card, ErrorNote, MacroRow, Spinner } from '../components/ui'

export default function RecipesPage() {
  const queryClient = useQueryClient()
  const recipes = useQuery({ queryKey: ['recipes'], queryFn: () => api.listRecipes() })

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRecipe(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recipes'] }),
  })

  return (
    <div className="page">
      <div className="page-head">
        <h1>Recipes</h1>
        <Link className="button button-primary button-small" to="/recipes/new">
          + New recipe
        </Link>
      </div>

      {recipes.isLoading && <Spinner />}
      <ErrorNote error={recipes.error} />
      <ErrorNote error={remove.error} />

      {recipes.data?.length === 0 && (
        <Card>
          <p className="empty">
            No recipes yet. Build one from foods in your library and its macros are computed for you.
          </p>
        </Card>
      )}

      <div className="grid">
        {recipes.data?.map((recipe) => (
          <Card
            key={recipe.id}
            title={<Link to={`/recipes/${recipe.id}`}>{recipe.name}</Link>}
            action={
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete ${recipe.name}`}
                onClick={() => remove.mutate(recipe.id)}
              >
                ✕
              </button>
            }
          >
            {recipe.description && <p className="muted">{recipe.description}</p>}
            <p className="muted small">
              {recipe.item_count} ingredient{recipe.item_count === 1 ? '' : 's'} ·{' '}
              {grams(recipe.total_weight_g, 0)} total · {recipe.servings} serving
              {recipe.servings === 1 ? '' : 's'}
            </p>
            <div className="per-serving">
              <span className="muted small">Per serving</span>
              <MacroRow n={recipe.per_serving} />
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
