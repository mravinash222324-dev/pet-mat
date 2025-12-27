// app/api/ai-advisor/chat/route.js

// Standard imports
import { textModel } from "../../../lib/gemini"; // Gemini AI instance
import connectDB from "../../../lib/mongodb";
import Pet from "../../../models/PetModel";

// Utility function to retrieve the current authenticated user ID.
// IMPORTANT: This implementation must be replaced with secure logic (e.g., extracting ID from
// session cookies, JWT headers, or server context) in a production environment.
function getCurrentUserId(req) {
    // Placeholder implementation: Assuming current user ID retrieval is successful.
    // In a real application, this user ID must be derived securely from the request context.
    // For demonstration, we assume we can identify the current user.
    return "current_user_123"; 
}


// Fetch pet details
async function getPetDetails(petId) {
  // Ensure the pet object includes the ownerId for authorization checks
  const pet = await Pet.findById(petId).lean();
  if (!pet) return null;

  // Handle missing names
  const sireInfo = pet.sireName || (pet.sireId ? "Registered (Name hidden)" : "Unknown");
  const damInfo = pet.damName || (pet.damId ? "Registered (Name hidden)" : "Unknown");

  return {
    // Include ownerId (converted to string if Mongoose ObjectId)
    ownerId: pet.ownerId ? pet.ownerId.toString() : null, 
    ...pet,
    lineageInfo: `Sire: ${sireInfo}, Dam: ${damInfo}`
  };
}

// POST request handler
export async function POST(req) {
  try {
    await connectDB();
    
    // 1. Authenticate and identify the user making the request
    // Note: The `req` object is necessary here to derive the session/user ID securely.
    const currentUserId = getCurrentUserId(req); 

    // Parse request body
    const { petAId, petBId, history, message } = await req.json();

    if (!petAId || !petBId) return new Response(JSON.stringify({ error: "IDs required" }), { status: 400 });

    // Fetch pet profiles
    const petA = await getPetDetails(petAId); // User's Pet
    const petB = await getPetDetails(petBId); // Target Pet 

    if (!petA || !petB) return new Response(JSON.stringify({ error: "Pets not found" }), { status: 404 });

    // 2. Authorization Check for Pet B Sensitive Data
    // Check if the current user is the owner of Pet B.
    const isAuthorized = petB.ownerId && petB.ownerId === currentUserId;

    let medicalHistoryForAI;
    let vaccinationDetailsForAI;
    
    if (isAuthorized) {
        // User is authorized: provide full details
        medicalHistoryForAI = petB.medicalHistoryLog || "No specific medical issues recorded.";

        // Format detailed vaccination list
        vaccinationDetailsForAI = petB.vaccinationHistory && petB.vaccinationHistory.length > 0
            ? petB.vaccinationHistory.map(v => `- ${v.vaccineName} (Expires: ${new Date(v.expiryDate).toLocaleDateString()})`).join("\n")
            : "No vaccination records visible.";
            
    } else {
        // Unauthorized: Redact and mask sensitive information
        console.warn(`[ACCESS DENIED] User ${currentUserId} attempted to access sensitive data for Pet B (${petBId})`);
        
        medicalHistoryForAI = "ACCESS DENIED: Detailed medical history log is private and requires authorization from the pet owner.";
        
        vaccinationDetailsForAI = "ACCESS DENIED: Vaccination records are private and require authorization.";
    }
    // End Authorization Check


    // Define AI instructions using the authorized/redacted data
    const systemPrompt = `
      You are an expert Pet Advisor and Geneticist.
      The user (owner of Pet A) is asking about Pet B (the target pet).

      **TARGET PET (PET B) DETAILS:**
      - Name: ${petB.name}
      - Species: ${petB.type}
      - Breed: ${petB.breed}
      - Age: ${petB.age}
      - Lineage: ${petB.lineageInfo}
      
      **MEDICAL HISTORY LOG (From Dr. Paws):**
      """
      ${medicalHistoryForAI}
      """

      **VACCINATION STATUS:**
      ${vaccinationDetailsForAI}

      **USER'S PET (PET A - For Compatibility Context):**
      - Name: ${petA.name}
      - Breed: ${petA.breed}
      - Species: ${petA.type}

      **INSTRUCTIONS:**
      1. Answer questions specifically about Pet B's health, history, or traits using the data above.
      2. If the user asks about "medical details", "surgery", or "illness", YOU MUST summarize the "MEDICAL HISTORY LOG" provided above.
      3. IMPORTANT: If the log or vaccination status states 'ACCESS DENIED', you must inform the user that this specific information is private and cannot be disclosed due to privacy restrictions.
      4. If asked about offspring, analyze compatibility based on Breed/Species.
    `;

    // Initialize chat history
    const chat = textModel.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: `I have reviewed ${petB.name}'s profile. Note that some medical details may be restricted based on permissions. What would you like to know?` }] },
        ...history // Add user history
      ]
    });

    // Get AI response
    const result = await chat.sendMessage(message);
    const responseText = result.response.text();

    return new Response(JSON.stringify({ text: responseText }), { status: 200 });

  } catch (err) {
    console.error("Advisor Error:", err);
    return new Response(JSON.stringify({ error: "Failed to generate advice" }), { status: 500 });
  }
}
```